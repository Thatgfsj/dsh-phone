# dsh-phone 架构（v1，基于 INTERFACES v0 + calibration）

> 依据：`docs/calibration.md`（本机 dsh 0.2.1-rc.2 源码证据）。本文在 INTERFACES v0 语义之上**细化**，
> 唯一修正见 §2.4：右侧栏扩展点从 `rightbar` slot 改为 **`ctx.sidebarRightTabs` tab 类型**（语义不变）。

## 1. 模块边界

```
              ┌────────────────────────── Host (Node) ──────────────────────────┐
 9 tools ───▶ │ src/tools/*         defineTool + tools/pre-execute(ask)           │
              │      │                                                            │
              │      ▼                                                            │
              │ src/phone/PhoneService  状态机/懒启动/互斥/节流/事件             │
              │      │              │                                             │
              │      ▼              ▼                                             │
              │ src/runtime/*    src/adb/*        src/stream/*                    │
              │ (redroid/        (Tango ADB,      (scrcpy server, H.264 透传,     │
              │  emulator/       纯 TS 直连)        WS 帧封装)                     │
              │  attach)              │                    │                      │
              │      │                └────────────────────┘                      │
              │      │                                             │               │
              │ src/http/routes.ts (/dsh-phone/api/*)  src/stream/ws.ts (/dsh-phone/stream) │
              │      │                                             │               │
              │ src/config/write.ts (settings.mutate 单键, volatile)              │
              │ src/tools/attach.ts (userHint→endpoint 解析, 探测)                │
              └──────────────────────────────────────────────────────────────────┘
                                     ▲ WebSocket/HTTP（同源）
              ┌────────────────────── Client (Web) ──────────────────────────────┐
              │ src/client/index.ts  __ModuleLoader__.load + slot/tab 注册        │
              │ src/client/panel.tsx  canvas + WebCodecs(H.264) + 触摸/按键转发    │
              │ src/client/settings.tsx 设置页：userHint/状态/重置                │
              │ src/client/connection.ts  WS 重连、可见性、二进制解帧             │
              └──────────────────────────────────────────────────────────────────┘
```

依赖方向：`tools → phone → {runtime, adb, stream}`；`http/ws` 只依赖 `phone`。
禁止 `runtime` 反向依赖 `phone`；禁止 Host import 任何 `@deepseek-ai/dsh-client-*`。

## 2. 关键机制（来自 calibration 的硬约束）

### 2.1 工具图片输出
`phone_screenshot` 的 `execute` 调 `ctx.get('attachments').saveImage({data,mediaType:'image/png',name})`，
`output.render` 返回 `[{type:'text'},{type:'image', attachment: {...ref}}]`。
attachment 缺失或路由不支持图片时，**降级为文本**（返回 PNG 字节的 base64 长度与提示），不得整体失败。

### 2.2 phone_shell 审批
Host 顶部注册一条 `tools/pre-execute` waterfall：`exec.name==='phone_shell'` 且不在白名单
（`getprop|wm size|dumpsys` 只读子集）→ 返回 `{kind:'ask', reason, displayReason:{en,zh}}`。
白名单常量集中在 `src/tools/shell-policy.ts`，单测覆盖。

### 2.3 配置写入（R1/R4/R5）
- 所有写路径只走 Host 的 `ctx.settings.mutate('dsh-phone', ops, revision)`；`attach.endpoint/resolved/userHint`
  必须是 `Config` 里的 `.volatile()` 叶子（否则 `settings` 拒绝写入）。
- Agent 写 endpoint 前必须：探测 → `POST /attach/verify`（不落盘）→ `mutate` 两个键 → 回读 `describe` 校验 → `phone_status` 复验。
- Client 设置页写 userHint：先 `host.call('config.describe')` 取 revision，再 `host.call('config.write', {path,value,revision})`。
- 禁止直接读写 `<profile>/cordis.patch.yml`。

### 2.4 右侧栏（修正 INTERFACES §7）
- **不注册 `rightbar` / `rightbar.session`**（single slot 已被官方占用，会遮蔽）。
- `ctx.effect(() => ctx.sidebarRightTabs.register({ id: '@local/dsh-phone/tab', kind: 'dshPhone', priority: 'extension', title: () => t('panel.title') }))`
- `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key: TAB_ID }, PhoneBody))`
  与 `sidebar.right.pane.tab.title` 同 key。
- 打开：`ctx.sidebarRight.openTab('dshPhone')`（按钮放 tab body 自身或设置页；**不自动弹**）。
- 面板可见性：tab body 内 `IntersectionObserver` + `document.visibilitychange` 双检测；
  不可见 → 发 `{type:'visibility',visible:false}` 并关闭 WS；Host 收到 0 viewer 即关流。

## 3. 冻结接口（v1）

### 3.1 RuntimeAdapter（与 INTERFACES §1 相同，补充错误类型）
```ts
export type RuntimeKind = 'redroid' | 'emulator' | 'attach'
export type PhoneState = 'stopped' | 'booting' | 'running' | 'paused'
export interface Endpoint { host: string; port: number }
export interface RuntimeProbe { ok: boolean; reason?: string; detail?: string }
export interface RuntimeStatus {
  kind: RuntimeKind; running: boolean; paused: boolean
  endpoint?: Endpoint; since?: number; pid?: number; containerId?: string
}
export interface RuntimeAdapter {
  readonly kind: RuntimeKind
  probe(): Promise<RuntimeProbe>
  ensureRunning(onProgress?: (msg: string) => void): Promise<Endpoint>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  status(): Promise<RuntimeStatus>
}
export class RuntimeUnavailableError extends Error {
  constructor(readonly kind: RuntimeKind, readonly hints: string[], cause?: unknown)
}
```

### 3.2 AdbConnection（同 INTERFACES §2）
`connect(endpoint,{timeoutMs=8000})` 必须：建 TCP → `AdbDaemonTransport.authenticate` →
`new Adb(transport)`；`shell()` 用 `adb.subprocess.noneProtocol.spawn('shell:'+cmd)` 收文本；
`shellRaw()` 用于 `screencap`；`push()` 用 `adb.sync().push`。
`raw` 暴露 `Adb` 实例给 stream 层（scrcpy 需要原实例）。
**禁止宿主机 adb 二进制**（SPEC §3.2）。

### 3.3 PhoneService（同 INTERFACES §3，补充）
```ts
startStream(sink: StreamSink): Promise<() => Promise<void>>  // 引用计数；0 viewer 后关流
touch(kind:'down'|'move'|'up', x:number, y:number): Promise<void>  // scrcpy control 通道
screenshot(): Promise<Uint8Array>   // screencap -p，PNG
```
互斥：`ensureRunning` 单飞（in-flight promise 复用）；`screenshot`/UI 操作串行队列
（同一时刻最多 1 个 `screencap`），避免抢占带宽。

### 3.4 StreamSink（同 INTERFACES §4）
```ts
export interface StreamSink {
  video(chunk: Uint8Array, meta?: { keyframe?: boolean; pts?: bigint }): void
  error(e: Error): void
}
```
Host 零转码：只把 `ScrcpyMediaStreamPacket` 原样分片转发；configuration packet 也作为视频帧下发
（客户端据此初始化 WebCodecs）。

### 3.5 HTTP / WS
路由与帧格式见 `docs/protocol.md`（冻结）。Host 侧统一 `ctx.connection.requestRejection(req)` 鉴权，
失败 401/403；WS 在 upgrade 阶段拒绝并 `socket.end('HTTP/1.1 403 ...')`。

## 4. 数据流

### 4.1 工具流（Agent → 设备）
`phone_tap` → `ensureRunning()`（stopped 则 lazy start，booting 等待且工具返回可重试中间态）
→ 设备壳命令 `input tap x y`（scrcpy 控制通道仅用于 inputText/touch）
→ 重置 idle 计时 → 返回 `{ok:true}`。截图返回 image block。

### 4.2 视频流（设备 → 人眼）
`openTab` 渲染 body → WS connect → Host `startStream`（若无流则 push scrcpy-server + start）
→ videoStream `ScrcpyMediaStreamPacket` → 每包加 8 字节头（`DPH1`+type+timestamp）→ WS binary
→ 客户端解帧 → WebCodecs `VideoDecoder`（失败回退 TinyH264 WASM）。
不可见/断开 → WS close → Host viewer 计数归零 → 停止 scrcpy 进程并关闭流（runtime 继续 running）。

### 4.3 设置流（人 ↔ 配置）
设置页输入一句话 → `host.call('config.write',{path:['attach','userHint'],value,revision})`
→ Host `settings.mutate`（volatile，原子落盘 profile patch）→ 回读 describe → 返回新 revision/状态。
「重置解析」= 用户点击 → 写 `resolved:false`（**只有用户能触发**；Agent 不主动）。

## 5. 文件拆分与行数预算（目标 ≤300/文件，硬上限 1000）

| 文件 | 预算 | 职责 |
|---|---|---|
| `src/index.ts` | 60 | 插件入口：Config、inject、装配 |
| `src/config/schema.ts` | 90 | Schemastery Config（volatile 叶子） |
| `src/config/write.ts` | 80 | settings.mutate 封装 + revision 冲突重试 |
| `src/runtime/types.ts` | 40 | RuntimeAdapter 等类型 |
| `src/runtime/detect.ts` | 110 | SPEC §3.1 决策树 |
| `src/runtime/redroid.ts` | 160 | docker CLI |
| `src/runtime/emulator.ts` | 170 | SDK emulator + 快照 |
| `src/runtime/attach.ts` | 90 | 仅连 endpoint |
| `src/adb/connection.ts` | 150 | TCP→AdbDaemonTransport→Adb |
| `src/adb/device.ts` | 180 | screenshot/tap/swipe/key/launch/dump |
| `src/phone/service.ts` | 260 | 状态机/单飞/队列/事件 |
| `src/phone/idle.ts` | 80 | idle/paused 计时器 |
| `src/stream/scrcpy.ts` | 180 | push server、start、video/control |
| `src/stream/ws.ts` | 200 | upgrade、分片头、viewer 计数 |
| `src/http/routes.ts` | 180 | api/status、config、verify、screenshot |
| `src/http/auth.ts` | 50 | requestRejection 包装 |
| `src/tools/index.ts` | 80 | 9 个注册汇总 |
| `src/tools/*.ts` ×9 | 40–70 每个 | 单工具 |
| `src/tools/shell-policy.ts` | 50 | 白名单 + pre-execute ask |
| `src/tools/attach.ts` | 220 | 一句话解析/候选探测 |
| `src/client/index.ts` | 120 | ModuleLoader/slots/tab/settings 注册 |
| `src/client/panel.tsx` | 260 | canvas/解码/输入/可见性 |
| `src/client/settings.tsx` | 160 | 设置页 |
| `src/client/connection.ts` | 180 | WS 重连/解帧 |
| `src/client/i18n.ts` | 60 | locale 字典 |

生成物：`lib/`（构建）、`lib/client.js`（esbuild 包装 `__ModuleLoader__.load`）不入库。

## 6. 并发与生命周期时序

```
stopped --tool/openTab--> booting --ensureRunning--> running
running --idle 5min--> paused --30min--> stopped
paused --任意交互--> running（redroid docker unpause 亚秒 / emulator 快照 3-6s / attach 重连）
```
- **单飞**：`ensureRunning()` 返回同一 in-flight promise；状态变更发 `onStateChange`。
- **工具并发**：`isConcurrencySafe: () => true` 只给 `phone_status`；其余默认 exclusive（会排队）。
- **流引用计数**：`startStream` 返回 release；第 1 个 viewer 开流，最后一个 release 后 5s 关流
  （避免 tab 切换抖动）。
- **卸载**：`ctx.effect` 逆序清理；先停流、再断 ADB、最后 runtime stop（redroid 不停机，仅 detach）。
- **配置热更新**：volatile 字段不重跑 apply，PhoneService 每次读 `config.x.get()`；禁止缓存配置快照。

## 7. 错误与重试策略

| 场景 | 行为 |
|---|---|
| runtime 探测失败 | `RuntimeUnavailableError`，工具返回 `{retryable:false, hints:[安装指引]}`，禁止静默 |
| booting | 工具/HTTP 返回 `state:'booting', bootMs`，客户端 1s 轮询 `phone_status`；≤60s |
| ADB 断连 | `connect` 指数退避 3 次（300/900/2700ms）；仍失败 → 状态 `stopped`+lastError，工具报可重试 |
| scrcpy server 起不来 | 关闭流、保留 runtime、WS 发 `{type:'error',code:'STREAM_START_FAILED'}`；下次可见时重试 |
| 截图/输入失败 | 重试 1 次（200ms）；仍失败抛 `DeviceCommandError`，工具内容含命令与 stderr 截断 |
| 配置冲突 | `SettingsConflictError` → 重新 describe 后重试 1 次，再失败提示用户 |
| viewer 掉线 | 立即减计数；流在 5s 宽限后关；不因单客户端断开影响 runtime |

统一错误码与 JSON 形状见 `docs/protocol.md`。
