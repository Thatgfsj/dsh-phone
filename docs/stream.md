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
| `control.ts` | INJECT_TEXT（中文）、INJECT_TOUCH、INJECT_KEYCODE；按键名映射 |
| `scrcpy.ts` | push scrcpy-server、start 会话、video 读循环、异常退出清理 |
| `session.ts` | viewer 引用计数、startStream 单飞、5s 宽限期、断开清理 |
| `websocket.ts` | 最小 RFC 6455 服务端帧编解码（基线无 `ws` 依赖） |
| `ws-messages.ts` | 文本消息形状校验（hello/touch/key/text/visibility/ping） |
| `ws.ts` | `registerStreamRoute(ctx)`：upgrade 鉴权、hello 时序、控制转发、连接替换 |

## 3. scrcpy-server

- 固定版本：**v3.3.3**（必须与 `@yume-chan/scrcpy` 2.3.0 的 latest 匹配，见 docs/calibration.md §6）。
- 官方下载：<https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3>
- **sha256：`7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`**（90164 bytes；
  2026-10-25 从上述官方 URL 实际下载后本地计算）。
- 许可：**Apache-2.0**（Genymobile/scrcpy 上游）。**jar 不提交仓库**，由 `.gitignore` 的
  `assets/scrcpy-server*.jar` 忽略；也不进入 npm 包（`files` 不含 assets）。

```sh
node scripts/fetch-scrcpy-server.mjs          # 下载 → 校验 sha256 → assets/scrcpy-server.jar
node scripts/fetch-scrcpy-server.mjs --check  # 只校验本地文件（不联网）
node scripts/fetch-scrcpy-server.mjs --force  # 忽略缓存重新下载
node scripts/fetch-scrcpy-server.mjs --mirror https://ghproxy.net/  # 追加镜像前缀
```

下载顺序：官方 GitHub URL → 默认镜像前缀（`ghproxy.net` / `ghfast.top`）→ `--mirror` 追加项；
只有 sha256 一致才原子替换目标文件。注意：**镜像可用性未验证**（见 §6）。
运行时可用环境变量 `DSH_PHONE_SCRCPY_SERVER` 覆盖 jar 路径（测试/打包用）。

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
- 下行：`ready`（width/height 取 hello viewport；codec/maxSize/maxFps）、`state`（booting/running/paused）、
  `pong`、`error`。
- 上行：`touch`/`key`/`text`（转发 PhoneService；异常回 `E_DEVICE_COMMAND`）、
  `visibility`（false → release viewer；true → 重新 attach）、`ping`（原样 pong）。
- 同一时刻只保留一条流连接：新连接到来时旧连接以 code 1000 关闭（避免重复 viewer）。
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

// Host 入口装配（建议显式传 getService；缺省依次探测 ctx.get('dshPhoneService'|'phoneService'|'dshPhone')）
registerStreamRoute(ctx, {
  getService: () => phoneService,
  getStreamOptions: () => config.stream, // ready 消息展示用；缺省 720/15/2Mbps
})
```

- `StreamSession`（session.ts）由 PhoneService 持有：
  `new StreamSession({ start: (sink) => startStream(adb, config.stream, sink) })`；
  `addViewer(sink)` 返回 release，由 PhoneService.startStream 透传给 ws 层。
- `AdbConnection` 以 `import type` 从 `../adb/transport.ts` 引入（runtime #3 冻结接口：
  `raw: Adb` 供 scrcpy 使用），本 PR 不复制实现、不修改 ADB 层。
- scrcpy 控制通道不可用时注入会抛错（不会静默吞掉）；按键名未知抛 `RangeError`。

### 与冻结文档的偏差（需 Lead 确认）

1. `registerStreamRoute(ctx)` 增加可选第二参数 `deps`（`getService/getStreamOptions/helloTimeoutMs/...`）。
   单参调用仍可用：缺省从 `ctx.get()` 探测服务键。原因：host 的服务注册键尚未在 docs 冻结。
2. `ready.width/height` 取客户端 hello 的 `viewport`（`startStream` 冻结返回类型不含元信息）。
   客户端应以 SPS 解码出的真实尺寸为准；如需精确值，可在后续把 `StreamInfo` 加入 host 契约。
3. WebSocket 服务端为自实现最小 RFC 6455（基线无 `ws` 依赖）；仅覆盖 DSH 同源场景。

## 7. 测试

```sh
node --test tests/stream/*.test.ts
```

覆盖：DPH1 字节序/类型映射/pts 回绕与负值/超大包、控制消息映射与中文文本、RFC 6455 握手向量与
掩码/分片/ping-pong/close、WS 鉴权拒绝、hello 校验与超时、viewer 计数与 5s 宽限、**断开/隐藏清理**、
**新连接替换旧连接**、异常流错误码、scrcpy-server 下载脚本的 sha256/--check/参数解析。
全部使用假 adb/假 socket，不依赖真机、scrcpy 二进制或网络（下载脚本测试只做本地文件校验）。

## 8. 未验证项（本机条件限制）

1. **scrcpy 实连未验证**：本机无 scrcpy 二进制、无真机/可用 attach 实例；`pushServer`、
   `AdbScrcpyClient.start`、video/control socket 只按 `@yume-chan` 类型与源码实现，未端到端跑通。
2. `video.sizeChanged` 的 `Event.on` 用法未验证（已用可选链保护，不影响主链路）。
3. `ctx.connection.requestRejection` 在自定义 upgrade 路由上的真实行为未实测
   （docs/calibration.md 未验证项 #4）；单测用假 connection 覆盖。
4. 镜像回退（ghproxy.net / ghfast.top）可用性未逐个验证；官方 URL 已实测下载并通过 sha256。
5. 浏览器侧 WebCodecs/TinyH264 解码、真实 720p/15fps/2Mbps 带宽与背压表现未验证（属 client #6）。
6. 本 PR 的 `AdbConnection` 为 `import type`；runtime 的 `src/adb/transport.ts` 合并前
   `npm run typecheck` 会报 `TS2307`（预期）。本地用临时 stub 验证其余类型通过，stub 未提交。
