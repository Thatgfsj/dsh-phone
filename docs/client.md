# Web 客户端（dsh-phone）

> 范围：`src/client/**`、`tests/client/**`。协议以 `docs/protocol.md` 为准，
> 集成点以 `docs/calibration.md` §4、`docs/architecture.md` §2.4 为准。
> 真实页面渲染验收由 task-8 执行，本文末列出**未验证项**。

## 1. 组件结构与注册

```
src/client/
  index.ts      入口：export default function(require) → { name, inject, apply }
  panel.ts       面板外壳：先读 /config 做 onboarding/Host 门控，再挂 streaming view；标题 seat
  panel-view.ts  tab body 的 streaming 视图（canvas/状态/重连/按键）
  header.ts      会话头部入口按钮（conversation.session.header.utilities list seat）
  auto-open.ts   onboarding accepted 时 best-effort 自动打开（≤10s 静默重试）
  gate.ts        面板门控判定（checking/ready/pending/declined/unavailable）
  empty-state.ts 面板空态：可读文案 + 内嵌 onboarding 三态卡
  boot.ts        booting 进度模型 + 1s /status 轮询器 + 进度 UI（#39）
  panel-status.ts 面板状态徽章文案/色调（从 panel-view 拆出，控制行数）
  settings.ts    设置页（onboarding 卡片/一句话/解析状态/重置/打开面板）
  settings-api.ts HTTP 客户端 + 409 冲突重试 + onboarding 类型 + 状态容错读取
  onboarding.ts  首次使用引导：三态描述 + 写入流程（纯函数）+ 卡片组件
  connection.ts  协议编解码 + 指数退避 + 可见性双检测门控（纯逻辑）
  stream.ts      WebSocket 生命周期：握手、重连、心跳、半开检测
  decoder.ts     解码编排：WebCodecs → 软解回退
  render.ts      两条解码路径共用的单 rAF 渲染循环（canvas、DPR、letterbox）
  h264.ts        Annex-B 解析 / WebCodecs 配置与 chunk 描述 / codec string（纯函数）
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
  id: '@local/dsh-phone/tab', kind: 'dshPhone', priority: 'extension',
  title: () => t('panel.title'),
}), 'dsh-phone: right sidebar tab type')

ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@local/dsh-phone/tab', locale: NS }, PhonePanel))
ctx.slots.inject('sidebar.right.pane.tab.title', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: '@local/dsh-phone/tab', locale: NS }, PhoneTitle))
```

- key = tab definition 的 `id`（seat 按 definition.id 派发）。
- 打开入口：会话头部手机按钮（§1.3）、设置页「打开手机面板」、以及加载后的 best-effort 自动打开（§1.3）；
  三者都调用 `ctx.sidebarRight.openTab('dshPhone')`，右栏按 contentId 去重/reveal。
- 未注册 `rightbar` / `rightbar.session`（single slot 被官方占用，注册会遮蔽右栏）。

### 1.2 设置页

`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section',
id:'dsh-phone', order:60, label: () => t('settings.section') }, PhoneSettings))`。

读写只走冻结 HTTP API：`GET /dsh-phone/api/config`、`POST /dsh-phone/api/config`
（`{path,value,revision}`）、`GET /dsh-phone/api/status`。`fetch` 用同源 cookie
（`credentials:'same-origin'`）。409 `E_CONFIG_CONFLICT` → 重新 GET 取 revision 后
**重试一次**，再失败显示可读错误。「重置解析」写 `attach.resolved:false`，仅用户点击，
带 `window.confirm`，Agent 侧不会调用。
- **开关只读展示**（#39 条目 6 / host #52）：`GET /config` 的可选 `enabled?: boolean` 映射为
  已启用 / 已关闭 / 未知（Host 未暴露）。开关变更仍需在插件管理中修改配置并重载插件
  （`enabled` 非 volatile）；设置页只展示状态 + 提示，不提供写入。
  `enabled === false` 时 Host 只提供只读 `GET /config`，因此 UI 提前隐藏 onboarding 卡 /
  一句话 / 重置解析 / 打开面板等写入与联动区，仅保留只读状态行 + 刷新按钮，避免触发 403 `E_NO_WEB`。


### 1.3 会话头部入口与自动打开（issue #45）

- 入口注册在 **`conversation.session.header.utilities`**（list、右对齐、`replaceRisk: none`）：
  `ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register(headerRegistrationOptions(t, NS), PhoneHeaderButton))`
  （id `dsh-phone`、order 50）。按钮是内联手机 SVG（16px），`title`/`aria-label` 走 i18n
  `header.open`；点击 `ctx.sidebarRight.openTab('dshPhone')`，`try/catch` 静默（无会话不报错）。
  **不使用** `conversation.session.header.corner`：该 single slot 已被官方
  `client-ui-sidebar-right ExpandButton` 占用（catalog `replaceRisk: shadows-shipped-ui`），
  注册会遮蔽官方右栏展开按钮（review 已确认改用 utilities）。
- **自动打开（best effort）**：`apply()` 末尾 `void maybeAutoOpenPhone({...})`——读一次
  `GET /dsh-phone/api/config`；**除 `declined` 外都尝试打开**（pending 也打开：面板首屏就是
  同意卡片，见 §4.1；accepted 打开；旧 Host 缺字段视为 accepted）。shell 尚未 adopt 会话时
  抛错 → 每 500ms 重试、最多 10s 后静默放弃；配置读取失败返回 `unavailable`。
  全程不阻塞 apply、不抛错。`declined` 不自动打开，header 图标仍可手动进入。
- **pending 自动打开后的第一眼**：面板内是 onboarding 三态卡（§4.1），用户可直接选运行时并同意，
  无需先去设置页；`declined` 时自动打开被跳过，手动打开会显示「已暂停使用」+ 重新启用。
- 打开幂等：右栏按 contentId 去重/reveal；header、设置页与自动打开打开同一 tab。

### 1.4 首次安装/更新后必须刷新页面（issue #48）

客户端插件模块（`lib/client.js`）在**页面启动时**进入 `window.__DSH_BOOT__` 启动图。
插件动态安装、更新或在插件管理中启用后，DSH 的 HMR 只会重建**已加载**模块，
不会向已打开页面注入新的模块行；因此旧页面会出现「Host 工具可用，但没有手机入口/设置页」。
处理：**刷新页面（F5）** 让启动图重算。

- 刷新**不中断会话**：Session 在 Host 侧持久化；手机实例的懒启动/休眠状态也在 Host，页面只是重连。
- 刷新后 auto-open（§1.3）会再执行一次：`pending` 会打开面板并显示确认卡，`accepted` 直接进入面板。
- 升级流程因此是「重启 DSH + 刷新页面」：仅刷新换不掉 Host/客户端模块代；仅重启不刷新旧页面也不会注入 UI。
- 旧页面无法由插件自己提示（插件代码不在旧图里），所以这条必须写入安装文档与 Agent 技能。

## 2. 视频协议（客户端视角）

- 全局单一 WebSocket：`ws(s)://<同源>/dsh-phone/stream`。
- 首帧 text：`{type:'hello',protocol:1,viewport:{w,h},visible:true}`。
- 下行 text：`ready{width,height,codec,maxSize,maxFps,deviceWidth?,deviceHeight?}` /
  `state{state,bootMs?}` /
  `pong{t}` / `error{code,message,retryable}`。
- 下行 binary：8 字节头 `"DPH1"` + u32 meta（高 4 位 frameType：0 config/1 key/2 delta/
  3 audio/4 control；低 28 位 pts@90kHz）；payload 为 H.264 Annex-B。一个 WS message =
  一个 scrcpy packet。`timestamp = round(pts * 1000 / 90)` µs。
- 上行：`touch{action,x,y}`（设备坐标）、`key{name}`、`text{text}`、`visibility{visible}`、`ping{t}`。
- 重连：仅可见时，`500ms * 2^n` 上限 8s，±20% 抖动；`ready` 后 n 归零。
- 心跳：每 20s 发 ping；60s 无任何下行则判定半开 → 主动重连。
- 不可见：`close(1000)`，不再重连（`IntersectionObserver` + `visibilitychange` 双检测，
  两者与后触发；见 `VisibilityGate`）。

### 2.1 触摸坐标系（跨任务注意）

协议 §2.1 的 `ready.width/height` 在已合并的 stream 实现里是**回声 hello viewport**
（= 画面尺寸），不是设备 framebuffer 尺寸；而 `touch{x,y}` 需要设备像素坐标。
客户端已前向兼容：`ready` 若带可选的 `deviceWidth/deviceHeight`（设备真实分辨率）
则用它做触摸换算，否则退回 `width/height`。若 Host 不补该字段，720p 缩放下点击会
偏移——已同步 Lead / stream owner 决策，客户端无需再改。

## 3. 解码路径与回退

1. **WebCodecs（首选，硬解）**：`VideoDecoder` 以 **Annex-B** 模式配置——
   `configure({ codec, avc: { format: 'annexb' }, optimizeForLatency: true })`，
   **不设 `description`**。codec string 由 configuration 包（SPS/PPS，Annex-B）的
   profile/compat/level 生成（如 `avc1.42E01E`）；configuration 包会**前置到第一个
   keyframe chunk**（in-band SPS/PPS），之后 keyframe/delta 直接透传 Annex-B。
   这样 Host 零转码、客户端零改写，避免「avcC description + Annex-B chunk」的
   WebCodecs 帧格式冲突（architect 审查发现的 BLOCKER）。
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
- `tinyh264` 已是直接依赖（#17/#19 起），`shims.d.ts` 声明了所用 API；
  **许可为 Apache-2.0**，代码会内联进 `lib/client.js` 随包分发，第三方声明由
  `docs/dependencies.md` 与文档任务 #7 维护（保留其 LICENSE 声明）。本 PR 不改 package.json。

## 4. 可见性门控（双检测）

`VisibilityGate`（`connection.ts`）同时订阅：
1. `document.visibilityState` / `visibilitychange`；
2. `IntersectionObserver(threshold: 0.01)` 观察 tab body 的 stage 元素。

二者都为真才可见；变化经 `StreamClient.setVisible`：不可见立即 `close(1000)` 并清空定时器，
可见时立即重连（`hello.visible=true`）。Host 侧据此把 viewer 计数归零并停流。

### 4.1 面板空态与 onboarding 门控

tab body 挂载时先 `GET /dsh-phone/api/config`，由 `describePanelGate()` 决定渲染：

- `checking`：「正在检查手机状态…」占位。初次读取会**短暂重试**（`gate.ts` 的
  `loadPanelConfig`：4 次 × 400ms），避免 Host 还在启动时首帧闪出 unavailable/连接错误
  （issue #47）；全部失败才进入 `unavailable`。pending 由 auto-open 自动呈现时，首屏直接是
  确认卡 + 选项，无需先找设置页；
- `ready`（accepted，或旧 Host 无 onboarding 字段）：挂 `panel-view.ts`，开始建流/解码；
- `pending` / `declined` / `unavailable`：渲染可读空态（`empty-state.ts`），**不建 WebSocket**、
  不黑屏。pending/declined 内嵌 `onboarding.ts` 三态卡（pending 可直接选运行时写入、declined 可
  重新启用）；Host 不可用显示错误摘要 +「重新检测」。
- **偏差**：DSH 0.2.1-rc.2 未向第三方 client 插件暴露「打开设置页/手机分区」的公开服务
  （settings shell 的 open/openSection 是 ui-settings-general 内部 store，shortcuts 服务也没有
  按 id 执行命令的 API），所以「也可在 设置 → 手机 中操作」是文案指引，实际入口是内嵌卡
  （issue #45 允许的方案）；不使用 DOM hack。
- 面板不读 `GET /status`，pending 时该接口的 `200 + ok:false E_ONBOARDING_REQUIRED` 不影响面板；
  设置页由 `readRunStatus()` 容错。

### 4.2 booting 进度（#39 条目 4）

冷启动（emulator 20–100s）期间面板不再只有一个转圈：

- 收到 WS `state{booting}` 后开始显示进度；若该帧带 `bootMs`（未来 Host 可加）直接用它，
  否则每 1s 轮询 `GET /dsh-phone/api/status` 取 `PhoneStatus.bootMs`（`bootMs` 是已耗时）。
- `boot.ts` 的 `describeBootProgress(bootMs)` 生成：已等待秒数、0–120s 进度百分比、阶段文案
  （<15s 拉起 / 15–45s 等待 adbd / 45–90s 首次冷启动较慢 / ≥90s 慢启动提示）与超时标记；
  进度条与徽章沿用 `--dsw-alias-*` token。
- 仅当**面板可见且 booting** 时轮询：`ready/running/paused/stopped` 或面板隐藏/关闭/卸载
  （`onState` hidden/closed、effect cleanup）都会 `stop()`；读取 `/status` 失败不报错，
  继续轮询并用本地 elapsed 兜底，避免 Host 正在启动时的瞬时 403/503 打断 UI。
- `ready` 后清空进度；`state.phase` 文案见 i18n `panel.boot.*`。

## 5. 首次使用引导（onboarding，issue #31）

配合 Host 侧 onboarding 守卫（issue #30）。契约：

- `GET /dsh-phone/api/config` 的 value 增加
  `onboarding: { status:'pending'|'accepted'|'declined', choice:''|'emulator'|'redroid'|'attach' }`
  （客户端把字段视为可选：缺失时按 `accepted` 处理，兼容旧 Host）。
- `POST /dsh-phone/api/config` 新增可写路径 `onboarding.status` / `onboarding.choice`
  （body 仍是 `{path,value,revision}`）。
- `GET /status` 在 pending 时返回 200 + `{ok:false,error:{code:'E_ONBOARDING_REQUIRED'}}`；
  `readRunStatus()` 把该码与 `E_NO_WEB`/`E_RUNTIME_UNAVAILABLE` 视为「暂无状态」，
  设置页不因此报错（面板不依赖 `/status`）。

三态（`describeOnboarding()` 纯函数，单测覆盖）：

| status | 显示 |
|---|---|
| `pending` | 引导卡片：标题/说明（运行中约 2GB 内存 + CPU）/「插件不会自动安装」提示；四个入口：SDK Emulator（展示 `sdkmanager ...`，约 1.7GB）、redroid（展示 binder 命令）、连接已有实例、暂不使用；此时隐藏一句话/解析/重置区域 |
| `accepted` | 「已启用：<choice>」+ 重新选择按钮，并显示原有 userHint/endpoint/resolved/运行状态区域 |
| `declined` | 「已暂停使用」（不启动实例、不占资源）+ 重新启用按钮；隐藏原区域 |

写入流程（`acceptOnboarding` / `declineOnboarding` / `reopenOnboarding`，均为纯函数）：

- accept：先写 `onboarding.choice`，用返回的**新 revision** 再写 `onboarding.status='accepted'`；
- decline：写 `onboarding.status='declined'`；
- 重新启用/重新选择：写 `onboarding.status='pending'`（保留 choice）；
- 每一步都走 `writeWithConflictRetry`：409 时重新 GET 配置、用新 revision 重试一次，再失败显示可读错误；
- **插件不安装任何软件**：卡片只展示命令文本，由用户在终端执行（SPEC §6.4）。

单测（`tests/client/onboarding.test.ts`，fake api + mock fetch）：三态描述、choice→i18n 映射、
accept 两步写入与 revision 传递、409 重试后继续写、decline/reopen、非 409 错误透传、
`GET /config` onboarding 解析、`readRunStatus` 对 `E_ONBOARDING_REQUIRED` 的容错、POST body 形状。

人工验证清单（真实页面由 #8 验收；`docs/verification.md` 由 #8 维护，以下为其素材）：

1. 首次安装（无 onboarding 记录）打开 设置→手机：显示 pending 卡片，文字与命令可读，四个按钮可用。
2. 点「使用 SDK Emulator」→「已启用：Android SDK Emulator」+ 原区域出现；GET /config 为 `accepted/emulator`。
3. redroid / attach 各验证一次：choice 写入正确、两步写入无 409 死循环。
4. 点「暂不使用」→「已暂停使用」+ 重新启用；刷新页面仍保持 declined。
5. 点「重新启用」→ 回到 pending 卡片，可重新选择。
6. 人为制造旧 revision（另一标签页先改配置）→ 自动刷新并重试一次后保存成功。
7. pending 时 GET /status 返回 `E_ONBOARDING_REQUIRED`：设置页仍正常渲染（不显示致命错误）。
8. 明暗主题下卡片/命令块可读（仅 `--dsw-alias-*` token）。

## 6. 测试与自检

```sh
npm run typecheck   # tsc --noEmit
node --test         # 纯逻辑单测 + 软解端到端（ffmpeg 生成 1 帧 keyframe，缺失则 skip）
npm run build       # lib/client.js（本机约 204KB）；Host 半边同时构建
node scripts/check-file-lines.mjs
```

覆盖：DPH1 解帧/校验/pts 换算、hello/touch/key/text/ping 序列化、server text 解析、
重连退避与抖动、可见性门控、不可见断流（`close(1000)`、无重连）、心跳半开重连、
设备坐标换算（letterbox/夹取）、WebCodecs configure/chunk 参数、codec string、I420→RGBA、软解真实关键帧、
header 入口注册与点击→openTab、auto-open 三态条件（pending 打开 / declined 跳过 / accepted 打开）
与重试/超时/不抛错、面板空态三态判定与文案、初次配置读取重试（首帧不闪错）、
booting 进度分段/百分比/超时文案与轮询器生命周期（假 clock/status）、enabled 三态展示判定与写入禁用。

## 7. 未验证项（真实浏览器 / 真实 Host 待 task-8）
1. WebCodecs 在 Chrome/Firefox/Safari 对 `avc.format='annexb'` + in-band SPS/PPS 的接受度；
   Chromium 对 Annex-B chunk 的接受度本机未在真实浏览器验证（协议 §2.2 只冻结了
   「configuration 置 description」，本实现改用 `avc.format=annexb` + in-band SPS/PPS，需真实页面确认）。
2. TinyH264 主线程软解在真实浏览器的 CPU/帧率（本机只在 Node 中验证 wasm 解码正确性）。
3. `IntersectionObserver` 在 DSH 右栏 tab 切换/浮动/折叠时的实际回调时机；
   不可见断流的行为有单测，真实页面待验。
4. 设置页 `fetch` 与 DSH 同源 cookie 鉴权的端到端写入（含 409 重试）未在真实 Host 跑过。
5. 软解回退发生在流中途时，等待下一个关键帧的实际时延（取决于 scrcpy 关键帧间隔）。
6. 面板真实渲染（主题 token、明暗切换、画布尺寸）未验证——task-8 负责。

7. onboarding 三态与写入（含 409 重试、`E_ONBOARDING_REQUIRED` 容错）只有单测；真实页面交互未验证（#8）。
8. 会话头部按钮在真实 header 的可见性/间距（utilities 右对齐列表）、点击后右栏展开行为未验证（#8）。
9. 自动打开的 adopt 时机（10s 窗口是否足够）未验证；仅单测覆盖重试/超时/静默失败。
10. pending 自动打开 + Host 冷启动竞态下的真实首屏顺序（是否确实先卡片、无错误闪动）需 #8 真机确认。
11. booting 进度依赖 `PhoneStatus.bootMs` 的真实刷新频率与冷启动时长（本机单测用假 clock；#44 合并后需 rebase 复验语义）。
12. `enabled` 字段已由 host #52（#53 合并）在 `GET /config` 暴露；真实页面下 enabled=true/false 的只读展示与写入区隐藏未验证（#8）。
11. 动态安装后「刷新页面 → 入口/自动打开出现」的真实页面流程未验证（#48 依据 DSH 客户端模块加载模型与
    用户反馈整理；「刷新不中断会话」为设计语义，Host 侧会话与实例状态不受页面刷新影响）。
