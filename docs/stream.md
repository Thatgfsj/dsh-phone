# 视频流：scrcpy + WebSocket（Host 侧零转码）

> 实现见 `src/stream/**`；协议字节格式以 [docs/protocol.md](./protocol.md) §2 为准（冻结）。
> 本文记录数据流、scrcpy-server 版本/校验和/许可、集成契约与**未验证项**。

## 1. 数据流

```
配置面板可见
  → Client new WebSocket('/dsh-phone/stream') + 首条 hello
  → Host ws.ts：requestRejection 鉴权 → hello 校验
  → PhoneService.ensureRunning()（懒启动，booting 期间下发 state:booting）
  → PhoneService.startStream(sink)（StreamSession 引用计数 0→1）
  → scrcpy.ts：pushServer → AdbScrcpyClient.start → videoStream / controller
  → videoStream: ScrcpyMediaStreamPacket
       ├─ configuration → DPH1 frameType=0（SPS/PPS 原样）
       ├─ data(keyframe) → frameType=1
       └─ data(delta)    → frameType=2
  → 8 字节头 + payload 原样 → WS binary（一个 scrcpy packet = 一条 WS message）
  → 浏览器 WebCodecs / TinyH264 解码（Client 侧，Host 不参与）

面板隐藏 / WS 断开
  → viewer 计数 -1；归零后宽限 5s → scrcpy 会话停止（runtime 保持 running）
```

**Host 零转码**：`src/stream` 只读取 packet 元信息、拼接 8 字节头与转发；
payload 不做解码、重编码、缩放、合并或拆分（仅因背压整包丢弃 delta 帧，见 §4）。

## 2. 文件职责（目标 ≤300 行/文件）

| 文件 | 职责 |
|---|---|
| `types.ts` | `StreamSink` / `StreamHandle` / `StreamController` / `StreamOptions` / `PhoneStreamService` 冻结契约 |
| `frames.ts` | DPH1 帧头编解码、scrcpy packet → frameType、µs→90kHz ticks、单调时钟 |
| `device-size.ts` | `adb shell wm size` → 设备物理分辨率（Physical/Override），按 endpoint 缓存 + 进程级快照 |
| `control.ts` | INJECT_TEXT（中文）、INJECT_TOUCH、INJECT_KEYCODE；按键名映射 |
| `scrcpy.ts` | push scrcpy-server、start 会话、video 读循环、异常退出清理 |
| `session.ts` | viewer 引用计数、startStream 单飞、5s 宽限期、断开清理 |
| `websocket.ts` | 最小 RFC 6455 服务端帧编解码（基线无 `ws` 依赖） |
| `ws-messages.ts` | 文本消息形状校验（hello/touch/key/text/visibility/ping） |
| `ws-connection.ts` | 单连接状态机：hello 时序、viewer attach/detach、DPH1 封帧、背压、异常清理 |
| `ws.ts` | upgrade 路由工厂：`createStreamUpgradeHandler` / `createStreamUpgradeRoute` / `registerStreamRoute` |
| `jar-provider.ts` | scrcpy-server.jar 懒下载（single-flight + sha256 + 超时 + 结构化错误） |
| `index.ts` | **稳定入口**：host 只 import 本文件（startStream/startControlOnly/工厂/类型） |

## 3. scrcpy-server

- 固定版本：**v3.3.3**（必须与 `@yume-chan/scrcpy` 2.3.0 的 latest 匹配，见 docs/calibration.md §6）。
- 官方下载：<https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3>
- **sha256：`7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`**（90164 bytes；
  2026-10-25 从上述官方 URL 实际下载后本地计算）。
- 许可：**Apache-2.0**（Genymobile/scrcpy 上游）。**jar 不提交仓库**，由 `.gitignore` 的
  `assets/scrcpy-server*.jar` 忽略；也不进入 npm 包（`files` 不含 assets）。

**无需手工跑脚本**：首次 `startStream` / `startControlOnly` 时若 `assets/scrcpy-server.jar` 缺失，
stream 层会自动调用同一个下载器（`src/stream/jar-provider.ts`）：

- **同进程 single-flight**：并发启动共享一次下载；失败后清除 in-flight，下次调用可重试；
- **sha256 校验**：下载后按固定校验和验证，不匹配则删除坏文件并报错；
- **超时**：默认 180s，超时错误可重试；
- **结构化错误**：`ScrcpyServerUnavailableError`（`code=E_SCRCPY_SERVER_UNAVAILABLE|E_SCRCPY_SERVER_TIMEOUT`、
  `retryable`、`manualCommand='node scripts/fetch-scrcpy-server.mjs'`），WS 层把 message/重试标记下发给客户端。

脚本仍保留，用于**离线/预下载/排障**（例如 CI 缓存、无网环境先手工放 jar）：

```sh
node scripts/fetch-scrcpy-server.mjs          # 下载 → 校验 sha256 → assets/scrcpy-server.jar
node scripts/fetch-scrcpy-server.mjs --check  # 只校验本地文件（不联网）
node scripts/fetch-scrcpy-server.mjs --force  # 忽略缓存重新下载
node scripts/fetch-scrcpy-server.mjs --mirror https://ghproxy.net/  # 追加镜像前缀
```

下载顺序：官方 GitHub URL → 默认镜像前缀（`ghproxy.net` / `ghfast.top`）→ `--mirror` 追加项；
只有 sha256 一致才原子替换目标文件。注意：**镜像可用性未验证**（见 §6）。
运行时可用环境变量 `DSH_PHONE_SCRCPY_SERVER` 覆盖 jar 路径（测试/打包用）；**该路径存在时不做自动
下载**——文件缺失或 sha256 不匹配会返回结构化错误（提示修正路径或取消环境变量）。

## 4. DPH1 二进制帧（逐字节对齐 docs/protocol.md §2.2）

```
byte 0..3  "DPH1" = 44 50 48 31
byte 4..7  u32 big-endian meta
           bits 31..28 frameType：0=configuration 1=keyframe 2=delta 3=audio(预留) 4=control(预留)
           bits 27..0  pts @90kHz（模 2^28 ≈ 2982.6s 回绕）
byte 8..   H.264 Annex-B payload（与 scrcpy packet.data 逐字节一致）
```

- `configuration` 包必须原样转发（客户端据此 `VideoDecoder.configure({description})`）。
- pts：scrcpy packet 的 `pts` 单位为**微秒**，Host 换算
  `ticks = floor((us*9 + 50) / 100)`（= round(us×90/1e6)），再模 2^28；负值/回绕均规范化。
  configuration 包无 pts 时用 Host 单调 90kHz 时钟（`StreamClock`，不回退）。
- **背压**：当 WS socket 缓冲超过 4 MiB 时仅丢弃 delta 帧（不拆包、不合包、不编码），
  keyframe/configuration 始终发送；客户端丢失 delta 后等下一个 keyframe。
- 一个 WS binary message = 一个 scrcpy packet；不做跨包合并/拆分。

## 5. WebSocket 文本协议（docs/protocol.md §2.3）

- 鉴权：upgrade 阶段先 `ctx.connection.requestRejection(req)`；非 `undefined` 时回
  `HTTP/1.1 401/403` 并销毁 socket。无 `ctx.connection`（无 web carrier）→ 503。
  不自写 Origin 比较（由 connection 层 fence 负责）。
- 首条必须 `hello`（`protocol:1`、`viewport{w,h}`、`visible`），5s 超时按 1008 关闭；
  重复 hello / 非 JSON / 非 hello 首条 → `{type:'error',code:'E_BAD_REQUEST'}` + close 1008。
- 下行：`ready`（width/height 取 hello viewport；**deviceWidth/deviceHeight 为 `wm size` 设备分辨率**，
  解析失败省略；codec/maxSize/maxFps）、`state`（booting/running/paused）、`pong`、`error`。
- 上行：`touch`/`key`/`text`（转发 PhoneService；异常回 `E_DEVICE_COMMAND`）、
  `visibility`（false → release viewer；true → 重新 attach）、`ping`（原样 pong）。
- 触摸坐标：客户端按 `ready.deviceWidth/deviceHeight` 把面板坐标换算为**设备坐标**；Host 的
  `ScrcpyController` 再按 `设备尺寸 → 视频尺寸`（`maxSize` 降采样）等比换算为 scrcpy 视频坐标注入，
  避免 1080x2400 真机在 720p 流下偏移。`wm size` 在每次 scrcpy 启动时查询一次并按 endpoint 缓存。
- 同一时刻只保留一条流连接：新连接到来时旧连接以 **4001** 关闭（issue #73）；客户端据此显示
  「已在另一处打开」并停止自动重连，避免双页互踢。
- **服务端空闲超时（issue #73）**：60s 未收到客户端任何消息 → 1011 `E_STREAM_IDLE`（半开连接清理）。
- **背压（issue #73）**：发送积压超过 `maxBufferedBytes` 时 delta 丢弃；configuration/keyframe 超限 →
  1011 `E_STREAM_BACKPRESSURE` 断开重连（config/keyframe 丢了会黑屏，不能静默丢）。
- socket close/error → 立即 release viewer；Session 在 0 viewer 后 5s 停流。
- 视频会话异常（启动失败/读失败/服务端退出）→ `{type:'error',code:'E_STREAM_START_FAILED',retryable:true}`
  后以 1011 关闭；客户端按协议自动重连。

## 6. 集成契约（给 Host/Client）

```ts
// PhoneService 需要结构上满足（INTERFACES §3；stream 不 import host 源码）
interface PhoneStreamService {
  ensureRunning(): Promise<void>
  startStream(sink: StreamSink): Promise<() => Promise<void>> // 引用计数 +1，返回 release
  touch(action: 'down' | 'move' | 'up', x: number, y: number): Promise<void>
  inputText(text: string): Promise<void>
  key(name: string): Promise<void>
}
```

**host 只 import `../stream/index.ts`**（稳定入口）：

```ts
import {
  createStreamUpgradeRoute, startControlOnly, startStream, StreamSession,
  type StreamHandle, type StreamSink,
} from './stream/index.ts'

// 有人看面板（video + control）
await startStream(adb, config.stream, sink)

// 无 viewer，但 Agent 需要 INJECT_TEXT / keyevent：
// 只建 control socket，**不建 video socket、不启动视频编码**（SPEC §3.6）
const controlOnly: StreamHandle = await startControlOnly(adb, config.stream)
await controlOnly.controller.injectText('中文输入')
await controlOnly.controller.injectKey('HOME')

// 视频引用计数会话（PhoneService 持有；0 viewer 宽限 5s 停流）
new StreamSession({ start: (sink) => startStream(adb, config.stream, sink) })

// WS：host 自己注册（鉴权由 getConnection 注入，失败回 401/403）
const route = createStreamUpgradeRoute({
  service: phoneService,
  getConnection: () => ctx.connection,
  getStreamOptions: () => config.stream,
})
ctx.webServer.registerUpgrade(route) // { path: '/dsh-phone/stream', handler }

// 或让 stream 层自行注册（内部复用同一个 handler；缺省从 ctx.get 探测服务键）
registerStreamRoute(ctx, { getService: () => phoneService })
```

- `startStream(adb, options, sink, { video?: false })` 与 `startControlOnly(adb, options)` 等价：
  **video=false 时不开 video socket/不启动编码**，返回的 `StreamHandle.controller` 仍可用
  （injectText/injectTouch/injectKey），`info` 为空。
- **`StreamSession`（session.ts）当前未被生产接线使用（issue #73）**：Host `PhoneService.startStream`
  自己维护 viewer 计数 + 代际（旧 release 忽略）+ 60s viewer 心跳（有人观看时 touch 生命周期，idle
  不会休眠）；`StreamSession` 保留为独立引用计数实现与测试夹具，后续如需多 viewer 扇出再切换。
  当前生产为「单 WS 连接（4001 替换旧页面）+ Host 计数」。
- **viewer 存活期间算交互**：Host 每 60s `lifecycle.touch()`；面板 touch/key/text 也 touch；
  idle 暂停前若仍有 viewer 会被否决（保持 running，不关流）。
- `AdbConnection` 以 `import type` 从 `../adb/types.ts` 引入（runtime #3 合并后的实际位置；
  transport.ts 只 import 未 re-export。冻结字段见 docs/architecture.md §3.2：`raw: Adb` 供 scrcpy 使用）；
  本 PR 不复制实现、不修改 ADB 层。
- scrcpy 控制通道不可用时注入会抛错（不会静默吞掉）；按键名未知抛 `RangeError`。

### 与冻结文档的偏差（需 Lead 确认）

1. `registerStreamRoute(ctx)` 增加可选第二参数 `deps`；另有稳定入口 `index.ts` 与
   `createStreamUpgradeRoute(deps) -> { path, handler }` / `createStreamUpgradeHandler(deps) -> handler`。
   原因：host 的路由装配方式与 service 注册键未在 docs 冻结。
2. `ready.width/height` 仍取客户端 hello 的 `viewport`（向后兼容旧客户端）；新增可选
   `deviceWidth/deviceHeight`（`wm size` Physical size，解析失败省略）。新增不影响既有字段语义。
3. WebSocket 服务端为自实现最小 RFC 6455（基线无 `ws` 依赖）；仅覆盖 DSH 同源场景。

## 7. 测试

```sh
node --test tests/stream/*.test.ts
```

覆盖：DPH1 字节序/类型映射/pts 回绕与负值/超大包、控制消息映射与中文文本、RFC 6455 握手向量与
掩码/分片/ping-pong/close、WS 鉴权拒绝、hello 校验与超时、viewer 计数与 5s 宽限、**断开/隐藏清理**、
**新连接替换旧连接（4001）**、**服务端 60s 空闲超时**、**背压（delta 丢弃 / keyframe 1011）**、异常流错误码、`wm size` 解析/缓存与 ready device 字段序列化、触摸设备→视频坐标换算、
scrcpy-server 下载脚本的 sha256/--check/参数解析、**jar 懒下载**（已存在跳过、成功、sha256 失败删除、
下载器异常、超时重试、并发 single-flight、环境变量覆盖路径）。
全部使用假 adb/假 socket/假下载器，不依赖真机、scrcpy 二进制或网络（下载脚本测试只做本地文件校验）。

## 8. 未验证项（本机条件限制）

1. **scrcpy 实连未验证**：本机无 scrcpy 二进制、无真机/可用 attach 实例；`pushServer`、
   `AdbScrcpyClient.start`、video/control socket 只按 `@yume-chan` 类型与源码实现，未端到端跑通。
2. `video.sizeChanged` 的 `Event.on` 用法未验证（已用可选链保护，不影响主链路）。
3. `ctx.connection.requestRejection` 在自定义 upgrade 路由上的真实行为未实测
   （docs/calibration.md 未验证项 #4）；单测用假 connection 覆盖。
4. 镜像回退（ghproxy.net / ghfast.top）可用性未逐个验证；官方 URL 已实测下载并通过 sha256。
5. 浏览器侧 WebCodecs/TinyH264 解码、真实 720p/15fps/2Mbps 带宽与背压表现未验证（属 client #6）。
6. `wm size` 输出解析只覆盖 Android 常见格式（`Physical size` / `Override size`）；折叠屏/多显示/
   旋转场景的物理尺寸稳定性未在真机验证（按 endpoint 缓存，假设查询期间分辨率不变）。
7. `AdbConnection` 的落点是 `src/adb/types.ts`（docs/architecture.md 写的 `transport.ts` 并未
   re-export）；runtime #15 合并后已按真实类型跑通 typecheck。若后续 runtime 在 transport.ts 补
   re-export，本层可切回。
8. **懒下载**：Host 侧默认路径已本机实测（官方 URL 下载 → sha256 → 二次调用复用），单测覆盖
   注入下载器的成功/校验失败/超时/异常/并发；**未在真机首次启动端到端验证**。首次下载依赖外网，
   离线环境会返回结构化错误（含手工命令），可用 `DSH_PHONE_SCRCPY_SERVER` 或预先跑脚本兜底；
   默认 180s 超时对慢网是否足够未实测。