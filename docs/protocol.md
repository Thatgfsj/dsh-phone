# dsh-phone 网络协议 v1（HTTP + WebSocket）

> 冻结契约：Host `src/http/routes.ts`、`src/stream/ws.ts` 与 Client `src/client/connection.ts` 共同依赖本文件。
> 所有路径相对同源 `location.origin`；只接受 loopback 部署（DSH Web 默认 `127.0.0.1:<port>`）。

## 0. 通用约定

- 前缀：`/dsh-phone`。HTTP 路由用 `ctx.webServer.register({kind:'prefix', path:'/dsh-phone/api'})`；
  WS upgrade 用 `registerUpgrade({ path:'/dsh-phone/stream' })`。
- 鉴权：每个请求先过 `ctx.connection.requestRejection(req)`；非 `undefined` 时：
  HTTP 返回该状态码（401/403），WS 在 upgrade 阶段回 `HTTP/1.1 <code> ...\r\nConnection: close\r\n\r\n`
  并 `socket.destroy()`。**不放行**非法 Origin；不添加任何 CORS 头。
- `ctx.connection` 不可用（无 web carrier）时：API 返回 503 `{code:'E_NO_WEB'}`，WS 直接拒绝。
- Content-Type：请求/响应均 `application/json; charset=utf-8`，除 `GET /screenshot`（`image/png`）。
- 缓存：`config/status` 一律 `Cache-Control: no-store`；screenshot 同。
- 错误体统一：
  ```json
  { "ok": false, "error": { "code": "E_...", "message": "人类可读", "retryable": true } }
  ```
- 成功体：`{ "ok": true, "value": <payload> }`（与错误体对称，便于客户端判别）。

## 1. HTTP 路由

| 方法 | 路径 | 请求体 | 成功 `value` |
|---|---|---|---|
| GET | `/dsh-phone/api/status` | — | `PhoneStatus`（见 §1.1） |
| GET | `/dsh-phone/api/config` | — | `{ runtime, attach:{endpoint,userHint,resolved}, stream:{maxSize,maxFps,bitrate}, revision }` |
| POST | `/dsh-phone/api/config` | `{ path:['attach','userHint'], value, revision }` | 同上（写后回读，R4） |
| POST | `/dsh-phone/api/attach/verify` | `{ endpoint:'127.0.0.1:5555' }` | `{ ok:boolean, latencyMs, banner?:string }`（**不落盘**，R5） |
| GET | `/dsh-phone/api/screenshot` | — | PNG 字节（`image/png`，非 JSON 包装） |

说明：
- `POST /config` 只允许三个键：`attach.userHint`、`attach.endpoint`、`attach.resolved`；其它路径 400 `E_BAD_PATH`。
  这是 R1「定点合并」的在线表达：Host 侧转成 `ctx.settings.mutate('dsh-phone',[{op:'set',path,value}], revision)`。
- `revision` 必须来自最近一次 `GET /config`；冲突返回 409 `E_CONFIG_CONFLICT`，客户端刷新后重试一次。
- `attach/verify` 内部执行 `connect(endpoint,{timeoutMs:3000})` + `getprop ro.product.model`；失败 200 + `ok:false`（便于列出候选），
  不写配置。R5：只有 verify `ok:true` 才允许随后写 endpoint/resolved。
- `screenshot` 走 Agent 截图通道（按需），不做缓存；失败返回 JSON 错误（`image/*` 不适用时）。
- 不提供 `POST /attach/reset`：重置 `resolved:false` 与清空 userHint 只能由**用户在设置页**触发，
  但走的是同一个 `POST /config`（用户点击 → 写 `resolved:false`）。Agent 工具不调用它。

### 1.1 PhoneStatus

```ts
interface PhoneStatus {
  state: 'stopped' | 'booting' | 'running' | 'paused'
  runtime: 'redroid' | 'emulator' | 'attach'
  platform: 'linux' | 'windows' | 'macos' | 'other'
  cpuPct?: number; memPct?: number; uptimeMs?: number; bootMs?: number
  endpoint?: { host: string; port: number }
  lastError?: string
}
```

## 2. WebSocket `/dsh-phone/stream`

不在 URL 上传 token（同源 Cookie 已由 connection 层认证）；`Sec-WebSocket-Protocol` 不协商。

### 2.1 握手时序

1. 客户端 `new WebSocket(url)`（或 `ctx.connection.openWebSocket('/dsh-phone/stream')`）→ open。
2. 客户端**第一条必须是 text JSON**：
   ```json
   { "type":"hello", "protocol":1, "viewport":{"w":720,"h":1280}, "visible":true }
   ```
3. 服务端：`ensureRunning()` → `startStream`（引用计数 +1）→ 回 text：
   ```json
   { "type":"ready", "width":720, "height":1280, "codec":"h264", "maxSize":720, "maxFps":15 }
   ```
   随后开始 binary 视频帧。启动中先回 `{"type":"state","state":"booting","bootMs":N}`，就绪后接 `ready`。
4. 客户端关闭 / 可见性变 false → 服务端 viewer 计数 -1；归零后 **宽限 5s** 再 `stopStream`。

### 2.2 二进制帧格式（8 字节头 + H.264 负载）

```
 byte 0..3   magic  = ASCII "DPH1" (0x44 0x50 0x48 0x31)
 byte 4..7   meta   = u32 big-endian
                     bits 31..28  frameType: 0=configuration(SPS/PPS) 1=keyframe 2=delta 3=audio(预留) 4=control(预留)
                     bits 27..0   pts，单位 1/90000 秒（90kHz），模 2^28，约 2982s 回绕
 byte 8..     H.264 Annex-B 负载（与 scrcpy MediaStreamPacket.data 逐字节一致，Host 零转码）
```

- 一个 WS binary message = 一个 scrcpy packet；**不跨包合并、不拆分**（客户端按 message 边界解）。
- `configuration` 包必须原样转发（含 SPS/PPS），客户端置 `description` 于 `VideoDecoder.configure`。
- `keyframe` 位用于客户端丢帧后快速恢复；delta 帧丢失时客户端不再解码，等待下一个 keyframe。
- `pts` 用于 WebCodecs `EncodedVideoChunk.timestamp`：`µs = round(ticks * 1000 / 90)`。

### 2.3 文本消息（JSON）

客户端 → 服务端：

| type | 字段 | 语义 |
|---|---|---|
| `hello` | `protocol`, `viewport{w,h}`, `visible` | 必须首条；重复则关闭连接 |
| `touch` | `action:'down'\|'move'\|'up'`, `x`, `y`（设备坐标） | 转 scrcpy `controller.injectTouch` |
| `key` | `name:'HOME'\|'BACK'\|'RECENTS'\|'ENTER'\|'DEL'...` | 转 `injectKeyCode` |
| `text` | `text:string` | 转 `controller.injectText`（**中文走这里**，非 shell input text） |
| `visibility` | `visible:boolean` | false 时服务端可暂停编码侧资源；true 触发重新 hello 语义 |
| `ping` | `t:number` | 心跳，服务端原样回 `pong` |

服务端 → 客户端：

| type | 字段 | 语义 |
|---|---|---|
| `ready` | `width,height,codec,maxSize,maxFps` | 流已建立 |
| `state` | `state`, `bootMs?` | 状态变化（booting/running/paused/stopped） |
| `pong` | `t` | 心跳回应 |
| `error` | `code`, `message`, `retryable` | 见 §3 |

### 2.4 重连与可见性

- 客户端自动重连：仅在 **可见** 时；退避 `500ms * 2^n`，上限 8s，加 ±20% 抖动；n 在成功 `ready` 后归零。
- 页面 `visibilitychange` 或 tab body 离开视口（IntersectionObserver 双检测）→ 立即 `close(1000)` 并置
  `visible:false`；恢复可见 → 重连并重新 `hello`。
- 服务端对同一页面只允许一条流连接：新连接到来时先关闭同源旧连接（`code 1000`），避免重复 viewer。
- 重连后**从头开始**（config packet + keyframe），不做断点续传。
- 心跳：客户端 20s 无 binary/text 发 `ping`；60s 无 `pong` 视为半开 → 主动重连。

## 3. 错误码

| code | HTTP/WS | retryable | 含义 |
|---|---|---|---|
| `E_AUTH` | 401 / close 1008 | false | `requestRejection` 拒绝（未认证/跨站） |
| `E_ORIGIN` | 403 / close 1008 | false | Origin/Host fence 拒绝 |
| `E_NO_WEB` | 503 | false | 无 web carrier 或 connection 服务缺失 |
| `E_BAD_REQUEST` | 400 | false | JSON/字段非法 |
| `E_BAD_PATH` | 400 | false | config 写路径不在白名单 |
| `E_CONFIG_CONFLICT` | 409 | true | revision 不匹配（刷新后重试一次） |
| `E_NOT_VERIFIED` | 409 | false | 试图写 endpoint 但未通过 verify（R5） |
| `E_RUNTIME_UNAVAILABLE` | 200/WS error | false | 决策树全失败，含安装指引 |
| `E_BOOTING` | 200/WS state | true | 启动中，带 `bootMs` |
| `E_STREAM_START_FAILED` | WS error | true | scrcpy server 启动/推包失败 |
| `E_STREAM_BUSY` | WS error | true | 已有会话且无法替换（正常不应出现） |
| `E_DEVICE_DISCONNECTED` | WS error | true | ADB 断开，runtime 仍 running |
| `E_DEVICE_COMMAND` | 500 | true | shell/input 执行失败，message 含截断 stderr |
| `E_TIMEOUT` | 504 | true | 操作超时 |

## 4. 安全

- 只绑定 loopback（DSH Web 默认 `host: '127.0.0.1'`）；不提供跨机访问面。
- 所有路由/upgrade 必须过 `ctx.connection.requestRejection`；不要手写 Origin 比较。
- 不信任 `Sec-WebSocket-Protocol`、不读取 query token；同源 Cookie 由 connection 层处理。
- 设备回传内容（shell 输出、UI XML）按不可信数据处理：只 JSON 文本转发，不注入 HTML；
  客户端渲染一律 React 文本节点。
- 日志脱敏：不打印完整 shell 命令（`phone_shell` 记录前 200 字符）与端点之外的路径。
- 单实例（`limits.maxInstances = 1`）：不提供 serial 参数与多流复用；新页面连接替换旧连接。

## 5. 与 INTERFACES v0 的差异

| 项 | INTERFACES v0 | 本文（v1） | 原因 |
|---|---|---|---|
| WS 头 | 「8 字节头：magic、类型、时间戳」未定布局 | 冻结为 `"DPH1"` + u32 meta（4b type + 28b pts@90kHz） | 给两端可并行实现的精确字节序 |
| `POST /config` body | `{key,value}` | `{path:string[], value, revision}` | 与 `settings.mutate` 的 path 语义对齐，支持嵌套 |
| `GET /screenshot` | 返回 PNG | 同，但注明错误时为 JSON | 明确 Content-Type 分支 |
| 重连 | 「指数退避」 | 500ms×2^n ≤8s + 抖动，仅可见时重连 | 可测试的确定性规则 |
