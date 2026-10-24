# Web 客户端（dsh-phone）

> 范围：`src/client/**`、`tests/client/**`。协议以 `docs/protocol.md` 为准，
> 集成点以 `docs/calibration.md` §4、`docs/architecture.md` §2.4 为准。
> 真实页面渲染验收由 task-8 执行，本文末列出**未验证项**。

## 1. 组件结构与注册

```
src/client/
  index.ts      入口：export default function(require) → { name, inject, apply }
  panel.ts      右侧栏 tab body（canvas/状态/重连/按键）+ 标题 seat 组件
  settings.ts    设置页（一句话/解析状态/重置/打开面板）
  connection.ts  协议编解码 + 指数退避 + 可见性双检测门控（纯逻辑）
  stream.ts      WebSocket 生命周期：握手、重连、心跳、半开检测
  decoder.ts     解码编排：WebCodecs → 软解回退
  render.ts      两条解码路径共用的单 rAF 渲染循环（canvas、DPR、letterbox）
  h264.ts        Annex-B 解析 / avcC 构造 / codec string（纯函数）
  yuv.ts         I420→RGBA（软解渲染，纯函数）
  input.ts       设备坐标换算 / 键盘映射（纯函数）
  i18n.ts        zh/en 组件文案（locale/{zh,en}.json 的 meta 由宿主读）
  styles.ts      仅 `--dsw-alias-*` token 的 CSS
  shims.d.ts     __ModuleLoader__ / tinyh264 模块声明（ambient，无顶层 import）
```

加载协议（`scripts/build.mjs` 包装，**未改 build.mjs**）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-phone',
  factory(require) { /* bundle */ return module.exports.default(require) },
})
```

因此源码 `index.ts` 必须 `export default function (require) { ... return { name, inject, apply } }`。
factory 只持有平台 `require`（只用 `require('react')`），**无模块级副作用**：
DOM、样式、服务注册全部发生在 `apply(ctx)` 里，样式以 React `<style>` 元素随组件渲染，
不向 `document.body` 追加节点。

### 1.1 右侧栏（不注册 rightbar）

```ts
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'dsh-phone/tab', kind: 'dshPhone', priority: 'extension',
  title: () => t('panel.title'),
}), 'dsh-phone: right sidebar tab type')

ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-phone/tab', locale: NS }, PhonePanel))
ctx.slots.inject('sidebar.right.pane.tab.title', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'dsh-phone/tab', locale: NS }, PhoneTitle))
```

- key = tab definition 的 `id`（seat 按 definition.id 派发）。
- 打开只由用户动作触发：设置页「打开手机面板」→ `ctx.sidebarRight.openTab('dshPhone')`；
  **加载时不自动 openTab**。
- 未注册 `rightbar` / `rightbar.session`（single slot 被官方占用，注册会遮蔽右栏）。

### 1.2 设置页

`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section',
id:'dsh-phone', order:60, label: () => t('settings.section') }, PhoneSettings))`。

读写只走冻结 HTTP API：`GET /dsh-phone/api/config`、`POST /dsh-phone/api/config`
（`{path,value,revision}`）、`GET /dsh-phone/api/status`。`fetch` 用同源 cookie
（`credentials:'same-origin'`）。409 `E_CONFIG_CONFLICT` → 重新 GET 取 revision 后
**重试一次**，再失败显示可读错误。「重置解析」写 `attach.resolved:false`，仅用户点击，
带 `window.confirm`，Agent 侧不会调用。

## 2. 视频协议（客户端视角）

- 全局单一 WebSocket：`ws(s)://<同源>/dsh-phone/stream`。
- 首帧 text：`{type:'hello',protocol:1,viewport:{w,h},visible:true}`。
- 下行 text：`ready{width,height,codec,maxSize,maxFps}` / `state{state,bootMs?}` /
  `pong{t}` / `error{code,message,retryable}`。
- 下行 binary：8 字节头 `"DPH1"` + u32 meta（高 4 位 frameType：0 config/1 key/2 delta/
  3 audio/4 control；低 28 位 pts@90kHz）；payload 为 H.264 Annex-B。一个 WS message =
  一个 scrcpy packet。`timestamp = round(pts * 1000 / 90)` µs。
- 上行：`touch{action,x,y}`（设备坐标）、`key{name}`、`text{text}`、`visibility{visible}`、`ping{t}`。
- 重连：仅可见时，`500ms * 2^n` 上限 8s，±20% 抖动；`ready` 后 n 归零。
- 心跳：每 20s 发 ping；60s 无任何下行则判定半开 → 主动重连。
- 不可见：`close(1000)`，不再重连（`IntersectionObserver` + `visibilitychange` 双检测，
  两者与后触发；见 `VisibilityGate`）。

## 3. 解码路径与回退

1. **WebCodecs（首选，硬解）**：`VideoDecoder`。configuration 包（SPS/PPS，Annex-B）
   转成 avcC `AVCDecoderConfigurationRecord` 置 `description`，codec string 由 SPS 的
   profile/compat/level 生成（如 `avc1.42E01E`）；`optimizeForLatency: true`。
2. **TinyH264（回退，WASM 软解）**：WebCodecs 不存在或 configure/decode 抛错时触发一次回退。
   使用 `tinyh264` 包（`@yume-chan/scrcpy-decoder-tinyh264` 的底层依赖）内置的
   Emscripten 模块，**主线程**解码，I420→RGBA 后交给同一渲染循环。
3. 两条路径都输出到 `CanvasRenderer` 的**同一个 rAF 循环**：只保留最新一帧，
   按 CSS 尺寸×DPR 设置 backing store，letterbox 居中绘制。
4. 丢帧恢复：configuration 之后、或回退之后，丢弃 delta 帧直到下一个 keyframe
   （协议 §2.2）。回退发生在流中途时不主动请求关键帧（协议无该消息），等待编码器
   周期性关键帧（scrcpy 默认约 10s 一个）。
5. 软解也失败 → `onError` → 面板显示可读错误文案，不白屏。

### 为什么不用 worker / 不改 build.mjs

`@yume-chan/scrcpy-decoder-tinyh264` 用
`new Worker(new URL('./worker.js', import.meta.url), {type:'module'})` 起软解 worker；
而 `scripts/build.mjs` 的 client 构建是 **`format:'cjs'` 单文件 bundle**：
esbuild 会把 `import.meta` 置空（运行期 `new URL(..., undefined)` 抛错），worker 文件也不会
被送达浏览器。DSH 虽支持包内 chunk（`/plugins/<id>/client.*.js?rev=<rev>`，见
`dsh-client-modules` 的 `CLIENT_CHUNK`/`chunkRequest`），但 rev 是构建期 hash，
客户端拿不到稳定 URL，v1 不做这个 hack。

代价与取舍（Lead 已批准方案 A）：
- `tinyh264` 的 wasm 以 base64 data URI 内联在 `tinyh264/es/TinyH264.js`，无需额外资产；
  **client bundle 因此增大**（本机 `lib/client.js` 约 204KB，其中约 150KB 来自
  tinyh264 glue+base64 wasm）。
- 软解在主线程跑，720p/15fps 下 CPU 占用高于 worker 版本；只在硬解不可用时启用。
- `tinyh264` 目前是**传递依赖**（经 `@yume-chan/scrcpy-decoder-tinyh264`），
  `shims.d.ts` 声明了所用 API；建议依赖 owner（#11）把 `tinyh264` 提为直接依赖，
  或后续显式移除 decoder 包。本 PR 不改 package.json。

## 4. 可见性门控（双检测）

`VisibilityGate`（`connection.ts`）同时订阅：
1. `document.visibilityState` / `visibilitychange`；
2. `IntersectionObserver(threshold: 0.01)` 观察 tab body 的 stage 元素。

二者都为真才可见；变化经 `StreamClient.setVisible`：不可见立即 `close(1000)` 并清空定时器，
可见时立即重连（`hello.visible=true`）。Host 侧据此把 viewer 计数归零并停流。

## 5. 测试与自检

```sh
npm run typecheck   # tsc --noEmit
node --test         # 纯逻辑单测 + 软解端到端（ffmpeg 生成 1 帧 keyframe，缺失则 skip）
npm run build       # lib/client.js（本机约 204KB）；Host 半边同时构建
node scripts/check-file-lines.mjs
```

覆盖：DPH1 解帧/校验/pts 换算、hello/touch/key/text/ping 序列化、server text 解析、
重连退避与抖动、可见性门控、不可见断流（`close(1000)`、无重连）、心跳半开重连、
设备坐标换算（letterbox/夹取）、avcC 构造、codec string、I420→RGBA、软解真实关键帧。

## 6. 未验证项（真实浏览器 / 真实 Host 待 task-8）

1. WebCodecs 在 Chrome/Firefox/Safari 对「avcC description + Annex-B chunk」的接受度；
   Chromium 实测通常接受 Annex-B chunk，但未在本机浏览器验证（协议 §2.2 只冻结了
   「configuration 置 description」，avcC 形态是本实现的适配，已在 h264.ts 注明）。
2. TinyH264 主线程软解在真实浏览器的 CPU/帧率（本机只在 Node 中验证 wasm 解码正确性）。
3. `IntersectionObserver` 在 DSH 右栏 tab 切换/浮动/折叠时的实际回调时机；
   不可见断流的行为有单测，真实页面待验。
4. 设置页 `fetch` 与 DSH 同源 cookie 鉴权的端到端写入（含 409 重试）未在真实 Host 跑过。
5. 软解回退发生在流中途时，等待下一个关键帧的实际时延（取决于 scrcpy 关键帧间隔）。
6. 面板真实渲染（主题 token、明暗切换、画布尺寸）未验证——task-8 负责。
