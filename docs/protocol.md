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
| GET | `/dsh-phone/api/status` | — | `PhoneStatus`（见 §1.1）；onboarding pending/declined → **200** `{ok:false,error:{code:'E_ONBOARDING_*',...}}`（见 §1.2） |
| GET | `/dsh-phone/api/config` | — | `{ enabled, runtime, onboarding:{status,choice}, attach:{endpoint,userHint,resolved}, stream:{maxSize,maxFps,bitrate}, revision }`（`enabled` 只读，见 §1.3） |
| POST | `/dsh-phone/api/config` | `{ path:['attach','userHint'], value, revision }`（也接受 `onboarding.status` / `onboarding.choice`） | 同上（写后回读，R4） |
| POST | `/dsh-phone/api/attach/verify` | `{ endpoint:'127.0.0.1:5555' }` | `{ ok:boolean, latencyMs, banner?:string }`（**不落盘**，R5） |
| GET | `/dsh-phone/api/provision` | — | `ProvisionStatus`（见 §1.4） |
| POST | `/dsh-phone/api/provision` | `{ runtime:'emulator'|'redroid'|'attach', image?:'google_apis'|'aosp_atd' }` | `ProvisionStatus`（仅浏览器同源；见 §1.4） |
| GET | `/dsh-phone/api/runtime` | — | `RuntimeInfo`（见 §1.5） |
| POST | `/dsh-phone/api/runtime` | `{ action:'start'|'stop'|'restart' }` | **202** 扁平体 `{ ok:true, action, state }`（异步执行，UI 轮询 GET /runtime） |
| POST | `/dsh-phone/api/action` | `{ action:'app-drawer' }` | **200** 扁平体 `{ ok:true }`；错误 409 `E_APP_DRAWER_UNAVAILABLE` / `E_LIFECYCLE_BUSY`（见 §1.6） |
| GET | `/dsh-phone/api/screenshot` | — | PNG 字节（`image/png`，非 JSON 包装） |

说明：
- `POST /config` 只允许五个键：`attach.userHint`、`attach.endpoint`、`attach.resolved`、
  `onboarding.status`、`onboarding.choice`；其它路径 400 `E_BAD_PATH`。
  这是 R1「定点合并」的在线表达：Host 侧转成 `ctx.settings.mutate('dsh-phone',[{op:'set',path,value}], revision)`。
- onboarding：`status ∈ pending|accepted|declined`（默认 pending，旧配置无该段也按 pending）；
  `choice ∈ ''|emulator|redroid|attach`（默认 ''）。**只能由浏览器同源通道（用户设置页/引导卡片）写**；
  本地 Agent 通道写 `onboarding.*` 与 `attach.userHint` 均返回 403 `E_FORBIDDEN`（issue #71：
  防 Agent 自我授权绕过首次使用守卫、防改 runtime）。
- `GET /screenshot` 在 pending/declined 时返回 200 + JSON `E_ONBOARDING_*`（不启动实例/不截图）。
- `revision` **必填**（缺失 → 400 `E_BAD_REQUEST`），必须来自最近一次 `GET /config`；冲突返回
  409 `E_CONFIG_CONFLICT`，客户端刷新后重试一次。这是 CAS：禁止 last-write-wins（issue #71）。
  本地 Agent 通道可 `GET /config`（仅读）以取得 revision。
- `attach/verify` 内部执行 `connect(endpoint,{timeoutMs:3000})` + `getprop ro.product.model`；失败 200 + `ok:false`（便于列出候选），
  不写配置。**endpoint 只允许 loopback（127.0.0.1/localhost/::1）且端口 ≥1024**（防内网端口探测）。
  R5：只有 verify `ok:true` 才允许随后写 endpoint/resolved；verified 记录 **TTL 5 分钟**，过期需重新 verify。
- 写 `attach.endpoint` / `resolved=true` 成功后，Host 在 **新连接**上复验（重连 + `getprop ro.product.model`，
  不复用旧 ADB）；未达到 running → 502 `E_DEVICE_DISCONNECTED`（issue #70，禁止旧端点假通过）。
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
  owned?: boolean; adopted?: boolean; pid?: number; since?: number  // issue #83
}
```

### 1.5 生命周期控制（issue #83）

```ts
interface RuntimeInfo {
  state: 'stopped' | 'booting' | 'running' | 'paused'
  running: boolean     // running/paused 视为进程存活
  owned: boolean       // true = 插件 spawn 的实例；false = adopt 用户已有实例
  adopted: boolean
  pid?: number
  endpoint?: { host: string; port: number }
  since?: number
  busy: boolean        // 有 start/stop/restart 动作在队列中/执行中
  lastError?: string   // 含动作错误码前缀（E_START_FAILED / E_STOP_FAILED / E_RESTART_FAILED）
}
```

- **GET /runtime**：只读快照（浏览器与 agent token 均可读），供 UI 轮询。
- **POST /runtime**：`{action}` 入队后立即返回 **202** 扁平体 `{ok:true,action,state}`（state 为入队前状态），
  动作在 Host 单队列中**串行互斥**执行；失败写入 `lastError`，UI 轮询 `GET /runtime` 展示。
- **鉴权差异（安全）**：`start`/`restart` 允许浏览器同源与 agent token（Agent 可自愈）；
  **`stop` 仅浏览器同源**，agent token 调用 → 403 `E_FORBIDDEN`（关闭手机是破坏性动作，必须用户触发）。
- **语义**：`stop` 对 owned 实例调用 adapter.stop（emulator 保存快照后退出；redroid 停容器）；
  adopted 实例只断开 ADB/流，**不杀用户进程**；booting 中 stop 会取消启动（runtime `cancelStart`）。
  `restart` = stop（若在运行）→ start；外部 kill 由 runtime 看门狗对账为 stopped + lastError。
- 错误码：`E_START_FAILED` / `E_STOP_FAILED` / `E_RESTART_FAILED` / `E_LIFECYCLE_BUSY`
  （动作失败体现在 `lastError`；HTTP 动作本身仍 202，UI 轮询判定）。
- **GET /status 兼容**：原 `PhoneStatus` 字段不变，新增可选 `owned/adopted/pid/since`（见 §1.1）。

### 1.6 面板动作 API（issue #100）

`POST /dsh-phone/api/action`，body `{ action: 'app-drawer' }`（目前仅此一个；home/recents 预留）：

- **固定命令**（不接受任何用户输入/拼接）：
  `am start -n com.dafeiyu.shell/.DrawerActivity --activity-single-top`，**5s 超时**；
- 前置 `ensureRunning()`；首次使用守卫 pending/declined 时返回 200 结构化 `E_ONBOARDING_*`（不碰设备）；
- 鉴权：浏览器同源与 **agent token 均允许**（固定命令无注入面）；
- 成功 **200** 扁平体 `{ ok:true }`（不套 `value`，issue #100 冻结）；
- 错误：
  - **409 `E_APP_DRAWER_UNAVAILABLE`**：Activity 不存在/未装定制/启动失败/超时；message 提示运行
    `system/provision-device.sh` 或更新肥鱼手机定制；超时 retryable=true，未安装 retryable=false；
  - **409 `E_LIFECYCLE_BUSY`**：生命周期动作或另一个面板动作正在执行（消息含稍后重试）；
  - 400 `E_BAD_REQUEST`：非法/未知 action。
- 若需扩展动作（home/recents），必须新增**固定命令常量**，不允许把 action 直接映射为字符串命令。

### 1.2 首次使用守卫（onboarding，issue #30）

- `onboarding.status !== 'accepted'` 时，9 个 `phone_*` 工具统一返回
  `{ok:false, code:'E_ONBOARDING_REQUIRED'|'E_ONBOARDING_DECLINED', retryable:false, onboarding?:{...}}`，
  且**不调用 ensureRunning、不启动/安装任何东西、不写配置**；由操作 Agent 向用户提问。
- `GET /status` 与 `GET /screenshot` 在 pending/declined 时返回 **200** + 同一结构化错误体
  （`error.onboarding` 含 step/question/options/install/docs），面板可展示引导而不报错。
- accepted 且 `choice` 非空 → 等价显式 `runtime=choice`（只走该 kind）；choice 空 → auto 决策树；
  运行时不可用仍返回 503 `E_RUNTIME_UNAVAILABLE`。

### 1.3 enabled 只读字段（issue #52）

`GET /config` 的 `value.enabled` 来自 `Config.enabled`（非 volatile；变更需重载插件）：

- 主 handler（插件启用）与只读 handler（`enabled=false` 时仅注册 GET /config）返回**同一形状**，
  客户端可据此显示「已启用 / 已关闭（只读）」并整体禁用写入区；
- 该字段**只读**：`POST /config` / `POST /agent/config` 均不接受 `enabled` 路径（400 `E_BAD_PATH`）；
- 旧 Host 兼容：客户端按「缺省视为 true / 或按自身默认」处理（客户端侧实现）。

### 1.4 一键准备运行环境（Provisioning，issue #65）

```ts
interface ProvisionStatus {
  state: 'idle' | 'running' | 'done' | 'failed'
  step: string        // precheck / locate / install / licenses / avd / customize / verify / done / failed
  percent: number     // 0–100（阶段估算；sdkmanager 输出含百分比时用于校正）
  log: string[]       // 最近 50 行（命令、输出摘要、错误、redroid 手动命令）
  error?: string      // state=failed 时
  runtime?: 'emulator' | 'redroid' | 'attach'
}
```

- **POST /provision** 仅在用户点击时调用；同源鉴权通过 `ctx.connection.requestRejection`（浏览器 cookie）。
- **幂等/并发**：`state=running` 时再次 POST 直接返回当前状态（不排队、不重复执行）；`done` 且
  runtime 相同直接返回；`failed` 或换 runtime 时重新开跑。
- **emulator**：`sdkmanager --install emulator <system-image>` → `sdkmanager --licenses`（stdin 恒 yes）→
  `avdmanager create avd -n dsh-phone-avd -k <system-image> -d pixel_5 --force`（仅当 AVD 不存在；
  已有 AVD 时快速 done，不重跑下载）→ **customize**（issue #88）→ **verify**。`image` 默认 `google_apis`
  （`system-images;android-34;google_apis;x86_64`），可选 `aosp_atd` 快启动镜像。
- **customize（issue #88，仅 emulator）**：AVD ready 后执行**包内固定路径** `system/provision-device.sh`
  （`bash <pkg>/system/provision-device.sh`，无参数、180s 超时、stdout/stderr 入 provision log）。
  脚本不存在 → 跳过并 log，不失败；执行失败 → log 警告但 **state 仍 done**（done+warn，不自动重试）。
  脚本会 reboot，Host 随后 **verify**：通过 Tango ADB 轮询默认 emulator 端口 `127.0.0.1:5555` 的
  `getprop sys.boot_completed`（≤180s）；超时只警告不失败。非默认端口时该校验会跳过/超时（见 host.md 未验证项）。
  插件**不会**接受外部脚本路径；`package.json files` 包含 `system/` 以随 tarball 分发。
- **redroid**：只检查 `docker version` 与 `/dev/binder`；不安装 Docker，缺失时 `state=failed` 且 `log`
  含来自 `src/runtime/install-guide.ts`（#38 单一数据源）的手动命令。
- **attach**：只校验当前 `attach.endpoint`（connect + getprop，不落盘）；成功 `done`，失败 `failed`。
- **安全**：只执行固定参数白名单命令；总超时 15 分钟（默认）；磁盘可用空间 <3GB 直接失败；
  只创建/复用 `dsh-phone-avd`，不碰用户其它 AVD；不修改配置。
- 错误：非法 `runtime`/`image` → 400 `E_BAD_REQUEST`；执行失败不抛 HTTP 错误，而是 200 +
  `state=failed` + `error` + 日志（便于面板展示与重试）。

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
| `touch` | `action:'down'\|'move'\|'up'`, `x`, `y`（**设备坐标**，按 `ready.deviceWidth/deviceHeight` 换算） | Host 等比换算为 scrcpy 视频坐标后 `controller.injectTouch` |
| `key` | `name:'HOME'\|'BACK'\|'RECENTS'\|'ENTER'\|'DEL'...` | 转 `injectKeyCode` |
| `text` | `text:string` | 转 `controller.injectText`（**中文走这里**，非 shell input text） |
| `visibility` | `visible:boolean` | false 时服务端可暂停编码侧资源；true 触发重新 hello 语义 |
| `ping` | `t:number` | 心跳，服务端原样回 `pong` |

服务端 → 客户端：

| type | 字段 | 语义 |
|---|---|---|
| `ready` | `width,height,codec,maxSize,maxFps,deviceWidth?,deviceHeight?` | 流已建立；device 字段为设备物理分辨率（`wm size`），解析失败时省略 |
| `state` | `state`, `bootMs?` | 状态变化（booting/running/paused/stopped） |
| `pong` | `t` | 心跳回应 |
| `error` | `code`, `message`, `retryable` | 见 §3 |

- `ready.deviceWidth/deviceHeight`（可选）：Host 在 scrcpy 启动时执行一次 `adb shell wm size`，取
  `Physical size: WxH`（缺失时回退 `Override size`）并缓存；解析失败则**省略字段**。客户端应优先用它
  把面板坐标换算成设备坐标，缺省时回退 hello 的 `viewport`（向后兼容）。
- `touch` 的 `x/y` 是设备坐标；Host 按 `设备尺寸 → scrcpy 视频尺寸`（`maxSize` 降采样）等比换算后注入，
  因此 1080x2400 真机在 720p 流下也不会偏移。`ready.width/height` 仍为 hello viewport 回声（兼容旧客户端）。

### 2.4 重连与可见性

- 客户端自动重连：仅在 **可见** 时；退避 `500ms * 2^n`，上限 8s，加 ±20% 抖动；n 在成功 `ready` 后归零。
- 页面 `visibilitychange` 或 tab body 离开视口（IntersectionObserver 双检测）→ 立即 `close(1000)` 并置
  `visible:false`；恢复可见 → 重连并重新 `hello`。
- 服务端对同一页面只允许一条流连接：新连接到来时先关闭同源旧连接（**`code 4001`**）；旧页面客户端
  进入终态并提示「面板已在另一处打开」，不自动重连（否则两页会互相 replace 无限互踢，issue #73）。
- **服务端空闲超时**：超过 60s 未收到客户端任何消息（hello/touch/key/text/visibility/ping）→ 1011
  `E_STREAM_IDLE` 断开（清理半开连接）。
- **背压**：WS 发送积压超过上限时，delta 帧丢弃（等下一个 keyframe）；configuration/keyframe 超限则
  1011 `E_STREAM_BACKPRESSURE` 断开（客户端重连拿新的 config+keyframe，避免黑屏）。
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
| `E_RUNTIME_UNAVAILABLE` | 503（HTTP 路由）/ WS error | false | 决策树全失败，message 含完整安装指引（工具路径返回结构化 `ok:false+hints`） |
| `E_ONBOARDING_REQUIRED` | 200（/status、/screenshot）/ 工具结构化 | false | 首次使用未确认；`onboarding` 含 consent 提问/选项/安装指引/docs |
| `E_ONBOARDING_DECLINED` | 200（/status、/screenshot）/ 工具结构化 | false | 用户选择暂不使用；可在设置页重新启用 |
| `E_BOOTING` | 200/WS state | true | 启动中，带 `bootMs` |
| `E_STOP_FAILED` | 动作结果（GET /runtime lastError） | true | 停止实例失败（取消启动/保存快照/杀进程失败） |
| `E_START_FAILED` | 动作结果（GET /runtime lastError） | true | 启动动作失败 |
| `E_RESTART_FAILED` | 动作结果（GET /runtime lastError） | true | 重启动作失败 |
| `E_LIFECYCLE_BUSY` | 409（POST /action）/ 动作结果（GET /runtime lastError） | true | 生命周期动作队列/面板动作繁忙 |
| `E_APP_DRAWER_UNAVAILABLE` | 409（POST /action） | 视原因 | 应用抽屉不可用：DrawerActivity 未安装/启动失败/超时；提示运行 provision-device.sh |
| `E_STREAM_START_FAILED` | WS error | true | scrcpy server 启动/推包失败 |
| `E_STREAM_IDLE` | close 1011 | true | 60s 未收到客户端消息（半开连接） |
| `E_STREAM_BACKPRESSURE` | close 1011 | true | WS 发送积压超限（keyframe/config 无法安全丢弃） |
| `E_STREAM_REPLACED` | close 4001（客户端本地事件） | false | 同一实例的新页面替换了本连接；提示已在另一处打开 |
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