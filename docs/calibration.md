# DSH 集成点校准（dsh 0.2.1-rc.2）

> 本文所有硬结论均来自**本机安装源码**，证据格式为 `包名/文件:行`。
> 路径简写：`$D = /home/thatgfsj/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`，
> 行号以 2026-10-24 本机采样为准。凡未经实跑验证的条目标注「未验证」。

## 0. 取证环境

| 项 | 值（本机实测） |
|---|---|
| dsh | `0.2.1-rc.2`（`$D/../..` 的 package.json） |
| 包数 | `$D` 下 305 个 `@deepseek-ai/*` 包 |
| Node | v24（支持 `node --test` 直跑 TS） |
| 本项目仓库 | `Thatgfsj/dsh-phone`，分支 `docs/2-calibration` |

复核命令：

```sh
D=~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
node -e "console.log(require('$D/dsh-tools/package.json').version)"
grep -n "register(definition" $D/dsh-tools/lib/types/index.d.ts
```

---

## 1. defineTool（工具注册，P0）

### 1.1 完整签名

`@deepseek-ai/dsh-tools` 顶层导出 `defineTool`（`dsh-tools/lib/types/index.d.ts:24`），
类型定义在 `dsh-tools/lib/types/schema.d.ts`：

- `DefineToolOptions<S, O>`：`schema.d.ts:178-240`
  - `name: string`、`description: string`、`parameters: S`（178-184）
  - `output: { schema: O; render(args,value): ContentBlock[]; presentationMeta?(args,value): JsonValue }`（186-193）
  - `deferLoading?`、`timeoutMs?`、`isConcurrencySafe?(args)`、`execute(args, exec): Promise<value>`、`projectContent?`、`finalizeContent?`、`presentCall?`、`presentResult?`（194-239）
- `defineTool()` 本体：`schema.d.ts:248`
  ```ts
  export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
  ```
- 注册：`ToolRuntime.register(definition: ToolDefinition): () => void`（`dsh-tools/lib/types/index.d.ts:637`），
  返回 **exact disposer**；`ctx.tools.register(...)` 本身已是 effect，插件卸载自动回收。

### 1.2 parameters 方言（不是 JSON Schema）

`ParameterSchemaSpec = { [key: string]: ParameterPropertySpec }`，属性是
`ValueSchemaSpec & { required?: true }`（`schema.d.ts:74-84`）。支持的 `type`：
`string | number | integer | boolean | null | array | object | json`，或 `oneOf`（≥2 分支）。
- 标量可用 `enum` / `const`；数组用 `items`；显式对象**必须**给 `additionalProperties: boolean`（58-62）。
- 必填靠属性级 `required: true`，**不是**对象级 `required: []`（74-76）。
- 编译产物是受限 JSON Schema：`parameterSchemaSpecToJsonSchema`（`schema.d.ts:163`），
  `assertSupportedJsonSchema` 会拒绝超集写法。

最小可运行片段（照 `dsh-tool-fs/lib/index.js:978-1050` 的真实形态裁剪）：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'phone_tap',
  description: '点击 Android 屏幕坐标 (x,y)。坐标必须来自最近一次截图或控件树。',
  parameters: {
    x: { type: 'integer', required: true, description: '像素 x' },
    y: { type: 'integer', required: true, description: '像素 y' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean', required: true },
    } },
    render: (_a, v) => [{ type: 'text', text: v.ok ? 'tapped' : 'failed' }],
  },
  async execute(args, exec) {
    await service.ensureRunning()
    await service.tap(args.x, args.y)   // 内部必须尊重 exec.signal
    return { ok: true }
  },
}))
```

### 1.3 工具名规则

- 唯一性：同一层重复注册失败；`run_code` 保留（`dsh-tools/lib/index.js:2970,2981`）。
- **字符集正则未在源码中找到显式校验**（grep `invalid tool name` 无命中）→ **未验证**；
  按既有生态一律用 `[a-z0-9_]+`，`phone_*` 满足。

### 1.4 审批 ask（phone_shell 的正确落点）

`PreToolDecision` 支持 `{ kind:'ask', reason?, displayReason?{en,zh,...} }`
（`dsh-tools/lib/types/index.d.ts:445-455`）。触发方式是 **waterfall 监听 `tools/pre-execute`**，
真实样例：`dsh-experimental-auto-review/lib/index.js:427-442,466`（`askUser()` 返回 `kind:"ask"`）。

```ts
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

const SHELL_WHITELIST = [/^getprop\b/, /^wm size\b/, /^dumpsys\b/]

ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.name !== 'phone_shell') return next()
  const cmd = String((exec.arguments as { cmd?: string }).cmd ?? '')
  if (SHELL_WHITELIST.some((re) => re.test(cmd.trim()))) return next()
  const decision: PreToolDecision = {
    kind: 'ask',
    reason: `phone_shell 将在设备上执行：${cmd}`,
    displayReason: { en: `Run on the Android device: ${cmd}`, zh: `将在 Android 设备上执行：${cmd}` },
  }
  return decision
}))
```

审批服务本身是 `ctx.approval.request(...)`（`dsh-user-approval/lib/types/index.d.ts:105-141`），
`PreToolDecision.ask` 由工具运行时的 `serviceAsk` 消费：`allowed-once` 才放行，其余 deny
（`dsh-tools/lib/types/index.d.ts` 的 `serviceAsk` 注释，约 817-828 行）。
**推荐用 pre-execute**：白名单逻辑与工具体解耦，且审批 UI 的 callId 关联由运行时完成。
未验证：在本机没有实际跑一次 ask 往返（审批 UI 交互）。

### 1.5 图片输出（phone_screenshot）

ContentBlock 只有 `text/reasoning/image/file/tool-call/...` 七类
（`dsh-llm/lib/types/types.d.ts:114-126`）；`ImageBlock.attachment` 必须是
`ImageAttachmentRef`（`types.d.ts:61-71`），媒体类型限 `image/png|jpeg|webp|gif`
（`dsh-attachment/lib/types/types.d.ts:5`）。

标准做法（官方 `read_image` 即此形态）：

1. `const ref = await ctx.get('attachments').saveImage({ data, mediaType:'image/png', name })`
   （`dsh-attachment/lib/types/index.d.ts:73`）；
2. `output.render` 返回 `[{type:'text',...},{type:'image', attachment: ref相关的六个字段}]`
   （`dsh-tool-fs/lib/index.js:966-981,1027-1071`）。

```ts
output: {
  schema: { type:'object', additionalProperties:false, properties: {
    image: { type:'object', additionalProperties:false, properties: {
      attachmentId:{type:'string',required:true}, mediaType:{type:'string',required:true},
      bytes:{type:'integer',required:true}, width:{type:'integer',required:true},
      height:{type:'integer',required:true},
    } },
  } },
  render: (_a, v) => [{ type:'text', text:'screenshot' }, { type:'image', attachment: v.image }],
}
```

风险（**必须实现兜底**）：
- 没有挂载 attachment 服务时 `ctx.get('attachments') === undefined`，官方工具直接抛错（`dsh-tool-fs/lib/index.js:1021-1023`）。
- 官方还会校验「当前模型路由声明了 image 输入」（`assertImageCapableRoute`，同上 1025 行）。
  dsh-phone 应捕获失败并退回 `[{type:'text', text:'截图已生成但当前模型不支持图片输入'}, ...]`，
  而不是让 `phone_screenshot` 整体失败。未验证：本机 `saveImage` 端到端实跑。

---

## 2. Config（Schemastery）与配置写入（P0）

### 2.1 声明与读取

`Config` 必须是 Schemastery schema（`@deepseek-ai/schemastery`，本机宿主版本 `~3.18.5`），
不是普通对象。真实样例：`dsh-agent-default-model/lib/index.js:22-24`、
`dsh-bash-local/lib/index.js:70-74`（`z.string().required().volatile()`、`z.number().default(...).volatile()`）。

```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(false),           // 开关权属用户
  runtime: z.union([z.const('auto'), z.const('redroid'), z.const('emulator'), z.const('attach')]).default('auto'),
  attach: z.object({
    endpoint: z.string().default('').volatile(),
    userHint: z.string().default('').volatile(),
    resolved: z.boolean().default(false).volatile(),
  }).default({ endpoint: '', userHint: '', resolved: false }),
  stream: z.object({
    maxSize: z.number().default(720), maxFps: z.number().default(15), bitrate: z.number().default(2000000),
  }).default({ maxSize: 720, maxFps: 15, bitrate: 2000000 }),
  lifecycle: z.object({
    idleTimeoutMs: z.number().default(300000), pausedTimeoutMs: z.number().default(1800000),
  }).default({ idleTimeoutMs: 300000, pausedTimeoutMs: 1800000 }),
  limits: z.object({ maxInstances: z.number().default(1) }).default({ maxInstances: 1 }),
})
```

要点：
- `apply(ctx, config)` 第二参即已校验配置；**只在 `.volatile()` 字段上可热改**（见 2.2）。
- 多行对象若整体 `.volatile()` 不成立，需在每个叶子字段上标；`attach.*` 三个叶子都标 volatile。

### 2.2 写入路径（关键）

宿主 `ctx.settings`（`dsh-settings`）提供**唯一的表单写 API**：

| API | 证据 | 约束 |
|---|---|---|
| `describe(options?)` | `dsh-settings/lib/types/index.d.ts:96` | 返回 `{ns, revision, value, base, user, schema, autoGenerate}` |
| `update(ns, patch, expectedRevision?)` | `index.d.ts:102`，实现 `lib/index.js:470` | **只能写 volatile 字段**（`lib/index.js:505-510,524-526`） |
| `mutate(ns, ops, expectedRevision?)` | `index.d.ts:114`，实现 `lib/index.js:488` | 同上；`{op:'set'|'unset', path, value}`，适合单键 |
| `replace(ns, section, expectedRevision?)` | `index.d.ts:108` | 重置所有实时字段后整体写 |

`settings.write` 先 `volatileForm(schema)`，无 volatile 字段直接抛
「Plugin entry ... has no volatile fields」（`lib/index.js:505-506`），并逐个校验
`isVolatilePath`（`lib/index.js:507,524-526`）。**所以 `attach.endpoint/resolved` 必须标 volatile**。

`ns` = profile 行 `id`（本项目 `dsh-phone`）。`expectedRevision` 来自 `describe()`，
不匹配抛 `SettingsConflictError`（`index.d.ts:30-44`）——Agent 写入前必须**先 describe 再 mutate**。

### 2.3 落盘算法（不用自己重写）

`dsh-settings` 委托 `ctx.configEditor.edit(entry, change)`（`dsh-config-editor/lib/index.js:69-135`）：

1. `documentPath = profileContext.patchPath`（`index.js:24-26`）＝ `<profile>/cordis.patch.yml`
   （`dsh-app-boot/lib/index.js:509,623`；模板见 593-597）；
2. `withFileLock(<profile>/package.json)` 串行化（`index.js:72`）；
3. 用 `yaml` 的 `parseDocument`（保留注释/顺序），定位末尾 id 匹配行，
   `document.setIn([index,'config'], ...)`；无行则 `document.add(...)`（`index.js:91-110`）；
4. **原子写** `writeFileAtomic`（`index.js:123`），随后 `reconcileProfilePatches` 热应用；
   失败则回滚原文并恢复（`index.js:124-130`）；
5. 若合成结果被 home patch / CLI overlay 覆盖，抛
   「overridden by a home patch or command-line overlay」（`index.js:122`）。

结论：**禁止自己读写 cordis.patch.yml**；用 `ctx.settings.mutate/update`（单键、volatile）
或 `ctx.configEditor.edit`（任意字段，但会触发 Loader 重载该行）。

### 2.4 两条写入方案与风险

| 场景 | 方案 | 风险 |
|---|---|---|
| 用户在设置页改 `userHint` | Client `host.call('config.write', {...})` → Host `ctx.settings.mutate('dsh-phone',[{op:'set',path:['attach','userHint'],value}])` | 字段必须 volatile；需带 revision |
| Agent 写 `attach.endpoint/resolved` (R1) | 同上，**单键两次 set 或一次 update**，值先经 `/attach/verify` 连通验证（R5） | volatile 更新**不重跑 apply**，插件必须从 `config.*` 引用实时读，否则读到旧值（未验证：本机未实跑 volatile 联动） |
| 需要重载生效 | `ctx.configEditor.edit(entry, change)` | 触发该行重载 → `apply` 重跑、服务状态丢失；期间工具调用需排队 |
| 兜底文件级 | 不允许（违背 R1 且 DSH 自身有冲突检测） | — |

### 2.5 设置页 UI

- 自动生成页：插件导出的 `Config` 会被 `ctx.settings.describe()` 投影成表单
  （`dsh-settings/lib/index.js:420-465`，`autoGenerate` 由 `ctx.settings.configure({auto})` 控制，`index.d.ts:80-83`）。
  **只有 volatile 字段进表单**（`volatileForm`）。本项目的 `userHint` 因此必须 volatile。
- 自定义页：Client slot `settings.section`（见 §4.4）。二者可并存。

---

## 3. ctx.webServer（HTTP + WS upgrade，P0）

服务：`ctx.webServer`（`dsh-host-webserver/lib/types/index.d.ts`，web 组合内由
`@deepseek-ai/dsh-host-webserver` 提供，见 `dsh-web-app/cordis.patch.yml:180`）。

```ts
interface WebRoute {
  kind: 'exact' | 'prefix'            // exact = 路径逐字；prefix = p 与 p/<anything>
  path: string                        // 绝对路径，无尾斜杠
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>  // 拥有完整响应生命周期
}
interface WebUpgradeRoute {           // 精确路径，一个 socket 只能有一个协议主人
  path: string
  handler(req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>
}
register(route: WebRoute): () => void          // 重复 (kind,path) 抛错
registerUpgrade(route: WebUpgradeRoute): () => void  // 重复 path 抛错
```

证据：`dsh-host-webserver/lib/types/index.d.ts:34-47,174,181`；
真实用法：`dsh-experimental-inspector/lib/index.js:2422-2461`（prefix 静态资源 + upgrade 反代）。

最小片段：

```ts
export const inject = ['webServer']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-phone/api',
    handler: (req, res) => { void handleApi(ctx, req, res) },
  }), 'dsh-phone: api route')

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/dsh-phone/stream',
    handler: (req, socket, head) => { acceptStream(ctx, req, socket, head) },
  }), 'dsh-phone: stream upgrade')
}
```

清理：两个注册都返回 disposer，放进 `ctx.effect` 即随插件卸载回收；
升级后的 socket 需自己跟踪并 `destroy()`（样例：`dsh-experimental-inspector/lib/index.js:2444-2459`
用 `Set<Duplex>` + 关闭时 Promise 等待）。

鉴权 / Origin（**必须**）：
- HTTP：`ctx.connection.requestRejection(req)` 返回 `undefined` 才放行
  （`dsh-client-connection/lib/types/rpc.d.ts:185`；样例 `dsh-experimental-inspector/lib/index.js:2470-2476` 把它映射成 401/403）。
- 首页类路由：`ctx.connection.authorizeIndex(req, res)`（`rpc.d.ts:217`）——dsh-phone 不用。
- 该 fence 自带 DNS rebinding + 同源校验（`dsh-client-connection/lib/types/api-request-trust.d.ts:1-13`）。
- `ctx.connection` 可能不存在（无 Web carrier 的 profile）：用 `ctx.inject(['connection'], ...)`
  包裹，或 `ctx.get('connection')` 判空后**拒绝**而非放行。

---

## 4. Web 客户端（P0）

### 4.1 package.json 与加载协议

`dsh.client` 声明 + `exports["./client"]`；第三方还需显式导出 `./package.json`、`./locale/*.json`
（否则展示元数据静默丢失）。参照 `dsh-client-ui-schedule/package.json`（`dsh.client{platform:'web'}`）。

浏览器加载契约：
`window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ...; return 插件 } })`
（bootstrap 注入见 `dsh-client-modules/lib/index.js:463-500`；注册实现见
`dsh-client-modules/lib/client.js:700-716`；id 必须等于包名）。
factory **必须返回** 函数 `(ctx)=>...` 或 `{name,inject,apply}`——返回 `undefined` 会报
「client half returned `undefined` — did you forget `return`?」（`dsh-cordis-client-runner/lib/client.js:183`）。

factory 的 `require` 只能取平台 seed（React 等）；**不要 require `@deepseek-ai/dsh-client-*`**。
可用内置符号（`dsh-cordis-client-runner/lib/client.js:6885-6910`）：`ctx`（受限 Cordis）、
`React`、`host.call(method,args)`、`styles.insert(css)`、`console`。
**客户端没有 fetch**：网络必须走 Host（`harness.handle` 的 JSON RPC）或浏览器原生
`WebSocket`/`ctx.connection.openWebSocket`（`dsh-client-connection/lib/client.browser.js:1423`）。

### 4.2 slots 注册

`ctx.slots.inject(ownerKey, () => ctx.slots.register(options, Component))`；
`options` 至少 `{ name }`，list/keyed slot 另带 `id`/`key`/`order`/`label`，
可加 `locale`、`inject: () => ({...props})`。真实样例：
`dsh-client-ui-schedule/lib/client.js:7454-7490`。

### 4.3 右侧栏：**不要注册 `rightbar`/`rightbar.session`**

- `rightbar` 是 **single slot**，已被官方 `client-ui-sidebar-right` 的 `RightbarRoot` 占用
  （catalog：`dsh-cordis-client-runner/lib/client.js:4793-4819`，`occupants: [client-ui-sidebar-right RightbarRoot]`）。
  再注册会**遮蔽**整个右侧栏（`replaceRisk: "shadows-shipped-ui"`）。
- `rightbar.session` 同样是 single 且被 `RightbarSeat` 占用（同上 4822-4857）。

正确扩展点 = **右侧栏的 tab 类型**（右侧栏是 dock 式多标签栏）：

1. 注册 tab 类型（definition：`{ id, kind, priority?, title(address), patterns?, canOpen?, multiple?, guide? }`，
   样例 `dsh-client-ui-schedule/lib/client.js:210-217`）：
   `ctx.effect(() => ctx.sidebarRightTabs.register(def), 'dsh-phone tab')`
   （注册实现 `dsh-client-ui-sidebar-right/lib/client.js:4465-4496`，服务由 4848-4849 提供）。
2. 注册 tab 体与标题，**key = definition.id**：
   `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key: TAB_ID }, PhoneBody))`
   `ctx.slots.inject('sidebar.right.pane.tab.title', ...)`
   （slot 契约 `dsh-cordis-client-runner/lib/client.js:5748-5851`；样例 schedule 7455-7472）。
3. 打开/开合：`ctx.sidebarRight.openTab(kind, options?)`（`.../client.js:2128`）、
   `toggleExpanded()`（2250）、`isExpanded()`（2246）、`tabsIn(sessionId)`（2111）、
   `close(tabId)`（2229）、`focus(tabId)`（2262）。
   打开面板 = `openTab(PHONE_KIND)`；面板作为 tab 存在期间才渲染，卸载即关闭。
4. 若需要在主区也有入口：`sidebar.panellist`（list slot，带 `id/order/label`，样例 schedule 7484-7490）。

**结论：INTERFACES §7 的「右侧栏用 rightbar slot」需按本节修正**（语义不变：人在右侧栏看手机），
否则会遮蔽官方右栏。

### 4.4 设置页

- 整页：`settings.section`（single？catalog 5292-5342）：`{ name, id, order, label }`，
  组件收到 owner props `{ close(): void }`。
- 单行：`settings.general.item`（catalog 4966-5023）：`{ name, id, order }`，**owner 不传 props**，
  文案/取值/写入全由自己（文档原文：copy、current value、write path 都是你的，through ... `host.call`）。
- 推荐：dsh-phone 用 `settings.section` 一页（一句话输入、解析状态、重置按钮、流参数只读展示）。
- `ctx.configForms` 是客户端设置域服务（`dsh-client-ui-settings-general/lib/client.js:1069-1114` 使用
  `ctx.configForms.describe()` 与 `ctx.remote`），第三方插件**不必**依赖它；读写走自己的
  `host.call` + Host 侧 `ctx.settings` 更稳。未验证：`configForms` 对第三方命名空间的暴露范围。

---

## 5. 持久化（草稿存储，P1）

`ctx.storage`：名为 backend 的注册表 + 可挂载 data form（`dsh-storage/lib/types/index.d.ts:1-60`），
`dsh-storage-json` 是 JSON 后端（base bundle 行 `storage`/`storage-json`/`storage-domain`，
`dsh-base/cordis.patch.yml:179-190`）。**本机未找到第三方插件直接写 storage 的官方样例** →
用 `ctx.storage` 需注入并自行处理 key 语义；**结论：v1 不落地草稿**，一句话原文以配置
`attach.userHint` 为唯一真源（符合 SPEC R2/R3）。未验证：`ctx.storage` 的第三方写入 API 细节。

---

## 6. @yume-chan 依赖（P1，版本已由 Lead 核实）

本机用 `npm pack` 解包到 `/tmp/yume-research` 读 `.d.ts`（临时产物，不提交）：

| 包 | 版本 | 关键 API |
|---|---|---|
| `@yume-chan/adb` | 2.6.4 | `Adb` 类：`createSocket`、`sync()`、`subprocess`、`framebuffer()`、`close()`（`esm/adb.d.ts:29-57`）；`AdbDaemonTransport.authenticate({connection, credentialStore, ...})`（`esm/daemon/transport.d.ts:100-118`）；`AdbDaemonConnection = ReadableWritablePair<AdbPacketData, Consumable<AdbPacketInit>>`（`transport.d.ts:12`） |
| `@yume-chan/adb`（auth） | 同上 | `AdbCredentialStore.generateKey()/iterateKeys()`（`esm/daemon/auth.d.ts:5-30`），RSA 2048 PKCS#8 |
| `@yume-chan/scrcpy` | 2.3.0 | `ScrcpyVideoStream{stream: ReadableStream<Uint8Array>, metadata{width,height,codec}}`（`esm/base/video.d.ts:2-17`）；`ScrcpyMediaStreamPacket = configuration{data} | data{keyframe?,pts?,data}`（`esm/base/media.d.ts`）；`ScrcpyControlMessageWriter`：`injectKeyCode/injectText/injectTouch/injectScroll/startApp/...`（`esm/control/writer.d.ts:8-39`）；`ScrcpyOptionsLatest = ScrcpyOptions3_3_3`（`esm/latest.d.ts`），init 含 `maxSize/maxFps/videoBitRate/tunnelForward`（`esm/3_3_1/options.d.ts:33-57`） |
| `@yume-chan/adb-scrcpy` | 2.3.2 | `AdbScrcpyClient.pushServer(adb, stream, filename?)`、`.start(adb, path, options)`、`.getEncoders/getDisplays`、`.videoStream: Promise<AdbScrcpyVideoStream>`、`.controller: ScrcpyControlMessageWriter|undefined`、`.output`、`.exited`、`.close()`（`esm/client.d.ts:23-76`）；`AdbScrcpyVideoStream{metadata,stream,sizeChanged,width,height}`（`esm/video.d.ts:4-13`） |
| `@yume-chan/scrcpy-decoder-tinyh264` | 2.1.0 | WASM 软解兜底（仅客户端用；焦点 API 未读 → 未验证） |

scrcpy-server jar：
- 版本必须与 `@yume-chan/scrcpy` 的 latest（3.3.3）匹配，由 `AdbScrcpyClient.pushServer` 推到
  `/data/local/tmp/scrcpy-server.jar` 后 `start(adb, path, options)`。
- **jar 不提交仓库**：用 `scripts/fetch-scrcpy-server.mjs` 从
  `https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3`
  下载并校验；许可 Apache-2.0（scrcpy 上游）。未验证：本机无 scrcpy 二进制/未实跑推包。

---

## 7. 安装验证阶梯（可复制）

```sh
# 1) 层与行（不启动）
dsh --profile <p> --dump-config | grep -n '^# =='      # 看层
dsh --profile <p> --dump-config | grep -n 'dsh-phone'  # 看行
dsh --profile <p> --dump-config-schema                 # 行/补丁 JSON Schema

# 2) Host 半边真加载（秒级、不绑端口）
dsh --profile <p> --patch /abs/overlay.yml --help

# 3) 真实页面：装进临时 profile 后启动，浏览器验 rightbar tab / settings 页 / 视频
```

overlay 样例（`name` 用绝对路径即插即用）：
```yaml
- insert:
    - id: dsh-phone
      name: '/abs/path/to/dsh-phone/index.js'
```

注意：`--help` 只覆盖 Host 半边；客户端组合失败只进 `ctx.logger.warn`，UI 必须真实页面验证
（技能 `references/client-plugin.md`「验证的边界」；本机 dsh 行为一致）。

---

## 8. 未验证项清单

1. `ctx.settings` 的 volatile 热更新与插件读取 `config.*.get()` 的端到端联动（只读源码）。
2. 审批 ask 的真实 UI 往返（`tools/pre-execute` 返回 ask → 用户点确认）。
3. `phone_screenshot` 经 `attachments.saveImage` 的端到端图片内容块（当前会话路由是否声明 image 输入）。
4. `ctx.connection.requestRejection` 在自定义 prefix 路由/upgrade 上的实际行为（只读类型与 inspector 样例）。
5. `ctx.storage` 第三方写入 API 细节；v1 不使用。
6. 客户端 `ctx.connection.openWebSocket` 的真实二进制帧收发（类型只声明 `send(string)`，需实测二进制是否支持；备选浏览器原生 `WebSocket`）。
7. scrcpy-server 下载与 `pushServer` 实跑；本机无 scrcpy 二进制、无可用 attach 实例。
8. `@yume-chan/adb` 直连 TCP adbd 的 Node 侧 `AdbDaemonConnection` 适配（需把 `net.Socket` 包成 WebStream；本机 waydroid adb 端口不可达）。
9. 工具名字符集是否有运行时正则校验。
10. 本机无 Docker / 无 emulator 二进制 / 无 AVD → redroid、emulator 适配器只能单测，不能集成验证。
