# 依赖基线与安装记录（#11）

本文件是 dsh-phone 的**唯一依赖真源**。实现 PR 不得再改 `package.json` / `package-lock.json`；
新增依赖先开 issue 由依赖基线负责人统一加，避免并行 PR 冲突。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| `npm install` 能否一次装齐全部候选依赖 | **能**（npm 11.19.0 / Node 24.21.0，见 §3） |
| 是否需要 `--legacy-peer-deps` | **不需要**，任何情况下都不许用它掩盖冲突 |
| `@deepseek-ai/*` 是否发布缺版本 | **不缺**：`dsh-tools@0.2.1-rc.2`、`schemastery@3.18.5`、`cordis@4.0.5` 均在 npm 上 |
| 是否需要 `src/shims/*.d.ts` 类型垫片 | **不需要**（类型解析实测通过，见 §3 trial C） |
| 宿主共享包是否误放 dependencies | **没有**，全部 `peerDependencies` + `devDependencies` |

> 注意：`npm view @deepseek-ai/dsh-tools version` 的 `latest` 指向 **0.0.1-rc.1**（历史遗留 dist-tag），
> 不代表最新版本。必须显式写 `0.2.1-rc.2` 或查 `npm view @deepseek-ai/dsh-tools versions`。

## 1. 依赖清单

`随 bundle 安装` 一列含义：**是** = 用户 `dsh plugin add` 时随插件一起装进 profile；
**否** = 由宿主提供（peer）或只在仓库开发期存在（dev），绝不重复安装。

### dependencies（公开 npm，随插件安装）

| 包名 | 版本区间 | 归属 | 用途 | 随 bundle 安装 | License |
|---|---|---|---|---|---|
| `@yume-chan/adb` | `^2.6.4` | dependencies | Tango ADB：纯 TS 直连 TCP adbd（`Adb`/`AdbDaemonTransport`/`AdbCredentialStore`） | 是 | MIT |
| `@yume-chan/stream-extra` | `^2.6.1` | dependencies | Tango 的 Web Streams 工具（`Consumable`、`WrapReadableStream`、`BufferedReadableStream` 等）；见 §5 为何直接声明 | 是 | MIT |
| `@yume-chan/scrcpy` | `^2.3.0` | dependencies | scrcpy 协议/选项/H.264 包解析/控制消息 writer | 是 | MIT |
| `@yume-chan/adb-scrcpy` | `^2.3.2` | dependencies | 把 scrcpy server 推到设备、起视频/控制通道（`AdbScrcpyClient`） | 是 | MIT |
| `tinyh264` | `^0.0.7` | dependencies | 浏览器端 **WASM 软解兜底**（#6 方案 A 主线程解码，用法见 §7）；wasm 以 base64 data URI 内联，无额外资产 | 是（仅 client bundle 引用） | **Apache-2.0** |

### peerDependencies（宿主提供，禁止放 dependencies）

| 包名 | 版本区间 | 归属 | 用途 | 随 bundle 安装 | License |
|---|---|---|---|---|---|
| `@deepseek-ai/dsh-tools` | `>=0.2.1-rc.2 <0.3.0` | peer | `defineTool` 等工具契约类型；运行时用宿主那份 | 否（宿主） | MIT |
| `@deepseek-ai/schemastery` | `~3.18.5` | peer | `Config` schema（Cordis Config） | 否（宿主） | MIT |
| `@deepseek-ai/cordis` | `~4.0.5` | peer | `Context` / 插件生命周期类型 | 否（宿主） | MIT |

### devDependencies（仅仓库开发/CI）

| 包名 | 版本区间 | 归属 | 用途 | 随 bundle 安装 | License |
|---|---|---|---|---|---|
| `@deepseek-ai/dsh-tools` | `0.2.1-rc.2`（精确） | dev | typecheck / `node --test` 的模块解析 | 否 | MIT |
| `@deepseek-ai/schemastery` | `~3.18.5` | dev | 同上 | 否 | MIT |
| `@deepseek-ai/cordis` | `~4.0.5` | dev | 同上 | 否 | MIT |
| `@types/react` | `^19.0.0` | dev | 客户端 `.tsx` 类型；React 本体由平台 `factory(require)` 提供 | 否 | MIT |
| `@types/node` | `^24.0.0` | dev | Node API 类型（`net`/`node:test` 等） | 否 | MIT |
| `esbuild` | `^0.25.0` | dev | Host 逐文件转译 + Client 单文件打包（`scripts/build.mjs`） | 否 | MIT |
| `typescript` | `^5.7.0` | dev | `tsc --noEmit` 严格模式检查 | 否 | Apache-2.0 |

直接运行时依赖里 `@yume-chan/*` 与 `@deepseek-ai/*` 均为 **MIT**；`tinyh264` 是 **Apache-2.0**
（宽松许可，与 MIT 兼容、无 copyleft 传染，但**要求保留版权与许可声明** —— 它会被打进 `lib/client.js`，
第三方许可清单由 #7 在 README/LICENSE 汇总）。`typescript` 为 Apache-2.0，仅开发期使用。

## 2. 版本策略

- **`@yume-chan/*` 整组同 minor 升级**：`adb-scrcpy` 在 `dependencies` 里声明了
  `@yume-chan/adb: ^2.3.1`、`@yume-chan/scrcpy: ^2.3.0`、`@yume-chan/stream-extra: ^2.1.0`，
  四个包共享协议常量（如 `ScrcpyOptionsLatest`）。升级必须五个一起升，然后重跑
  `npm install && npm run check`，不要只改一个。
- **`@deepseek-ai/dsh-tools` devDependency 用精确版本**：它的 `peerDependencies` 全是**精确版本**
  （`0.2.1-rc.2`），本地用 range 会让「类型签名」与「宿主实际加载的那份」漂移。
  peer 区间保持 `>=0.2.1-rc.2 <0.3.0`，兼容性最终由 `engines.dsh` 判定
  （`engines.dsh` 存在时 peer 区间被忽略，见 dsh-plugin-skills `plugin-package.md`「版本兼容门」）。
- **`schemastery` / `cordis` 用 `~`**，与宿主 `@deepseek-ai/dsh@0.2.1-rc.2` 的 `dependencies` 一致
  （`~3.18.5` / `~4.0.5`），避免出现第二份实例。
- **升级 `@deepseek-ai/*` 必须同步改 `engines.dsh`**（当前 `>=0.2.1-rc.2 <0.3.0`）。
- **`tinyh264` 用 `^` 但只看 0.0.x**：它还是 0.x 预发布形态（当前 `0.0.7`），`^` 实际锁死 0.0；升级时
  必须按 §7 的三种导入路径（`es/TinyH264.js` 默认导出 = Emscripten Module 工厂、`es/TinyH264Decoder.js`
  默认导出 = 解码器类、包根 `es/index.js` 含**无扩展名**相对导入）重新核对，并重跑 client bundle 冒烟。

## 3. /tmp 安装试验记录（改仓库之前完成）

环境：Node `v24.21.0`、npm `11.19.0`、registry `https://registry.npmmirror.com/`。

**Trial A —— 5 个 `@yume-chan/*` + devDeps**

```
$ npm install @yume-chan/adb@^2.6.4 @yume-chan/stream-extra@^2.6.1 @yume-chan/scrcpy@^2.3.0 \
    @yume-chan/adb-scrcpy@^2.3.2 @yume-chan/scrcpy-decoder-tinyh264@^2.1.0
added 12 packages in 913ms
$ npm install -D @types/node@^24 @types/react@^19 esbuild@^0.25 typescript@^5.7
added 7 packages in 1s
```

**Trial B —— 单独验证 `@deepseek-ai/*` 的 peer 可解析性**

```
$ npm install -D @deepseek-ai/schemastery@~3.18.5 @deepseek-ai/cordis@~4.0.5
added 4 packages in 367ms
$ npm install -D @deepseek-ai/dsh-tools@0.2.1-rc.2
added 19 packages in 1s
```

**Trial C —— 与仓库 package.json 完全一致的组合（含 peerDependencies 段）**

```
$ npm install
added 42 packages in 1s
$ npm ls --depth=0            # 见下方 §3.1，无 invalid / 无 UNMET PEER
$ npx tsc --noEmit            # exit=0（import 三个 @deepseek-ai/* + 四个 @yume-chan/* 全部解析成功）
```

**Trial C 的 TS 探针**（证明不需要 `src/shims` 垫片）：

```ts
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { Adb } from '@yume-chan/adb'
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
import { ScrcpyOptionsLatest } from '@yume-chan/scrcpy'
export const Schema = z.object({ a: z.string().default('x') })
export type Ctx = Context
```

### 3.1 仓库内实际安装结果（#11 时点，保留作历史记录）

```
$ npm install
added 42 packages in 993ms
$ npm ls --depth=0
dsh-phone@0.0.0 /home/thatgfsj/AIagent/.phone-wt/deps
├── @deepseek-ai/cordis@4.0.5
├── @deepseek-ai/dsh-tools@0.2.1-rc.2
├── @deepseek-ai/schemastery@3.18.5
├── @types/node@24.19.2
├── @types/react@19.3.0
├── @yume-chan/adb-scrcpy@2.3.2
├── @yume-chan/adb@2.6.4
├── @yume-chan/scrcpy-decoder-tinyh264@2.1.0
├── @yume-chan/scrcpy@2.3.0
├── @yume-chan/stream-extra@2.6.1
├── esbuild@0.25.12
└── typescript@5.9.3
$ npm ls --all | grep -Ei 'UNMET PEER|invalid|ERR!'   # 无输出
```

### 3.2 修正后的安装结果（#17：tinyh264 提为直接依赖、移除 decoder 包）

```
$ npm install
added 39 packages in 1s                      # #11 时为 42，移除 decoder 包后减少 3
$ npm ls --depth=0
dsh-phone@0.0.0 /home/thatgfsj/AIagent/.phone-wt/deps2
├── @deepseek-ai/cordis@4.0.5
├── @deepseek-ai/dsh-tools@0.2.1-rc.2
├── @deepseek-ai/schemastery@3.18.5
├── @types/node@24.19.2
├── @types/react@19.3.0
├── @yume-chan/adb-scrcpy@2.3.2
├── @yume-chan/adb@2.6.4
├── @yume-chan/scrcpy@2.3.0
├── @yume-chan/stream-extra@2.6.1
├── esbuild@0.25.12
├── tinyh264@0.0.7
└── typescript@5.9.3

$ npm ls tinyh264
dsh-phone@0.0.0 ... └── tinyh264@0.0.7        # 直接依赖，不再是 phantom dep
$ npm ls @yume-chan/scrcpy-decoder-tinyh264
dsh-phone@0.0.0 ... └── (empty)               # 已移除
```

## 4. peer 冲突处理

**本轮没有冲突，没有使用 `--legacy-peer-deps`，也没有启用 `src/shims` 垫片。**

需要知道的行为（不是错误，是 npm 7+ 的 peer 自动安装）：

- npm 会把 `@deepseek-ai/dsh-tools` 的 **20 个 `@deepseek-ai/*` peer**（`dsh-agent`、`dsh-llm`、
  `dsh-session`、`dsh-scope`、`dsh-sandbox` …）装进本地 `node_modules` 并写进 lock
  （lock 共 68 条）。它们**只在本地开发/类型检查时存在**：不进 `files` 白名单、不进 tarball；
  用户 `dsh plugin add` 走 pnpm 只装 `dependencies`，devDeps 与其 peer 树不会出现。
- 因此 `package-lock.json` 变大是预期的，review 时看 `packages[""].dependencies/peerDependencies`
  与 5 个 `@yume-chan/*` 链接即可。
- 若将来某个 `@deepseek-ai/*` devDependency 因 peer 冲突装不上：**不许用 `--legacy-peer-deps`**。
  做法是（a）去掉该 devDependency，（b）由 host 任务在 `src/shims/*.d.ts` 提供最小声明垫片，
  （c）在 issue 里记录缺的类型面。本轮**不适用**，`src/shims` 目录未创建。
- 本地不装 `@types/react` 时客户端 `.tsx` 会失去类型，但仍可构建；`@types/react` 只是类型。

## 5. Node ESM 下 Tango 流适配注意事项（P1）

已在 Node 24 实测（`node probe.mjs`）：

```
OK   @yume-chan/adb            -> ADB_DAEMON_DEFAULT_FEATURES, Adb, AdbDaemonTransport, ...
OK   @yume-chan/stream-extra   -> AbortController, Consumable, BufferedReadableStream, WrapReadableStream, ...
OK   @yume-chan/scrcpy         -> AndroidKeyCode, ScrcpyOptionsLatest, ...
OK   @yume-chan/adb-scrcpy     -> AdbScrcpyClient, AdbScrcpyOptionsLatest, ...
globals: ReadableStream=function WritableStream=function TransformStream=function TextEncoder=function navigator.usb=undefined
```

要点：

1. **纯 ESM**：四个包都是 `"type": "module"` + `main: esm/index.js` + `sideEffects: false`，
   Node 20+ 直接 `import` 可用，不需要 `createRequire`；Host 构建（esbuild `format: esm`、裸导入
   external）与之匹配。
2. **Web Streams 无需 polyfill**：Node ≥18 自带全局 `ReadableStream`/`WritableStream`/`TransformStream`，
   Tango v2 的内部管道可以直接跑。
3. **WebUSB 后端在 Node 不可用**：`navigator.usb === undefined`，`AdbWebUsbBackend` 这条路只能在浏览器用；
   Host 侧必须走 TCP，自己实现 `AdbDaemonConnection = ReadableWritablePair<AdbPacketData, Consumable<AdbPacketInit>>`
   —— 即把 `net.Socket` 包成 WebStream。这是 `docs/calibration.md` 未验证项 #8，也是 v1 最大风险点。
   可选实现：`node:stream` 的 `Readable.toWeb()` / `Writable.toWeb()`，或
   `@yume-chan/stream-extra` 的 `WrapReadableStream` / `WrapWritableStream`（**两种都未实测**）。
4. **为什么 `@yume-chan/stream-extra` 明明是被传递依赖还直接声明**：它虽然是 `adb`/`scrcpy`/
   `adb-scrcpy` 的 `dependencies`（装了 12 个包时已在树里），但我们要**直接 import** `Consumable`、
   `WrapReadableStream` 等。直接声明可以避免依赖 npm/pnpm 的 hoisting 布局，升级时也有明确版本锚点。
   版本取与传递依赖同 minor（`^2.6.1`）。
5. **打包边界**：Host 用 `bundle: false` + 裸导入，运行时由 profile 的 `node_modules` 解析；
   Client 侧 esbuild `platform: browser`，`react` 与 `@deepseek-ai/*` 已 external。
   **Host 代码不得 import `tinyh264`**（浏览器/WASM 专用；`TinyH264.js` 依赖 `fetch`/DOM 环境）。
6. 服务端消费 H.264 时用的是 `@yume-chan/scrcpy` 的 `ScrcpyMediaStreamPacket` 与 NAL/协议头解析，
   不改码流、不解码（架构 §4「Host 侧零转码」），所以 Host 侧没有 WASM 依赖。

## 6. 为什么 scrcpy-server jar 不进 npm dependencies

- 它不是 npm 包：scrcpy 上游只发 GitHub Release 资产（无 npm 发布），版本必须与
  `@yume-chan/scrcpy` 内置的 `ScrcpyOptionsLatest`（**3.3.3**）严格对齐，否则设备端起不来。
- 许可证不同：scrcpy server 是 **Apache-2.0**（Genymobile/scrcpy），`@yume-chan/*` 是 MIT；
  把 jar 打进 tarball 会让「随 npm 分发的二进制」边界变复杂。
- 体积与平台无关性：约 100 KB 的 Android jar，对不需要它的人纯属负担。
- 落地方式（由 #5 stream 任务实现）：`scripts/fetch-scrcpy-server.mjs` 从
  `https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3` 下载并校验，
  存到 `assets/scrcpy-server-v3.3.3.jar`（`.gitignore` 已忽略 `assets/scrcpy-server*.jar`），
  运行时由 `AdbScrcpyClient.pushServer` 推到 `/data/local/tmp/scrcpy-server.jar`。
- 本机与 CI 都不预置 jar；离线场景由用户手动放到 `assets/`，文档在 #7 补。

## 7. 客户端软解：用 `tinyh264`，不用 `@yume-chan/scrcpy-decoder-tinyh264`

**结论（#6 方案 A，已落地于 #17）**：client 软解兜底不再使用 `@yume-chan/scrcpy-decoder-tinyh264`
（已从 `dependencies` 移除），改为直接 import `tinyh264` 的 `es/` 子路径，在主线程解码。
主路径仍是 WebCodecs 硬解。

### 7.1 为什么 decoder 包不可用

`@yume-chan/scrcpy-decoder-tinyh264` 在构造解码器时用
`new Worker(new URL('./worker.js', import.meta.url))` 起 worker。而仓库现有客户端构建
（`scripts/build.mjs`）是 **`format: 'cjs'` 单文件 bundle**，esbuild 实测给出：

```
● [DEBUG] "import.meta" is not available with the "cjs" output format and will be empty [empty-import-meta]
  49 │ worker = new Worker(new URL("./worker.js", import.meta.url), {
```

`import.meta` 被置空 → 运行期 `new URL('./worker.js', undefined)` 抛错：**构建不报错，是运行期才炸**。
当时实测打包产物 156,649 bytes 且 `WebAssembly` 出现 0 次 —— worker 与 WASM 都没被内联。

### 7.2 唯一允许的导入方式

```ts
// 默认导出 = Emscripten Module 工厂；WASM 以 base64 data URI 内联，无需额外 .wasm 资产
import createTinyH264Module from 'tinyh264/es/TinyH264.js'
// 默认导出 = 解码器类（**不是** named export）
import TinyH264PictureDecoder from 'tinyh264/es/TinyH264Decoder.js'
```

- **只能走 `es/` 子路径**。包根 `tinyh264`（`main: lib/index.js` / `module: es/index.js`）里的
  `es/index.js` 是 `import { init } from './TinyH264Worker'`（**无扩展名**），Node ESM 下直接 import 包根会失败。
- 两个文件都只有 **default** export；写 `import { TinyH264Decoder } ...` 会被 esbuild 报
  `No matching export in "node_modules/tinyh264/es/TinyH264Decoder.js" for import "TinyH264Decoder"`（已实测）。
- `tinyh264@0.0.7` **没有 `exports` 字段、也没有类型声明** → 子路径可直接解析（Node + esbuild 均验证），
  但需要 ambient 声明（client 侧在 `src/client/shims.d.ts`）。
- 解码器构造函数是 `new TinyH264Decoder(module, onPictureReady)`，输出 YUV420（`Uint8Array`），
  色彩转换由 client 自己做（`src/client/yuv.ts`）。

### 7.3 打包实测（仓库 client 构建参数）

```
$ esbuild entry.js --bundle --format=cjs --platform=browser \
    --target=chrome110,safari16,firefox115 --external:'@deepseek-ai/*' --minify
exit=0   174,631 bytes
markers: import.meta.url=0  new Worker(=0  WebAssembly=1  data:application=1
```

→ 无 worker、无 `import.meta`、WASM 内联为 base64 data URI，**单文件 CJS bundle 可正常工作**；
minify 后 client bundle 增加约 170 KB（只在软解路径被引用，esbuild 会打进同一个 client.js）。

### 7.4 维护红线

- **不得再 import `@yume-chan/scrcpy-decoder-tinyh264`**（已从依赖移除）；若要恢复，需先解决
  worker + `import.meta` 与单文件 CJS bundle 的冲突（例如把 client 改成 esm 并额外产出 worker chunk）。
- **Host 侧禁止 import `tinyh264`**（浏览器/WASM 专用）。
- 升级 `tinyh264` 必须重跑 §7.3 的 bundle 冒烟，并核对 default export 形状与 `es/` 文件列表。

## 8. 维护规则与自检清单

任何人改依赖都要跑：

```sh
npm install                 # 同步 package-lock.json
npm ls --depth=0            # 版本符合预期
npm ls --all | grep -Ei 'UNMET PEER|invalid|ERR!'   # 必须无输出
npm run check               # typecheck + node --test + 行数
npm run build               # host 转译 + client 打包
npm pack --dry-run          # 确认 files 白名单没有 node_modules / jar
```

红线：

- 实现 PR **不得**改 `package.json` / `package-lock.json`；缺依赖先开 issue。
- `@deepseek-ai/*` **只能**在 `peerDependencies` + `devDependencies`。
- 禁止 `--legacy-peer-deps`、禁止把 `node_modules`/`lib/`/`*.tgz`/jar 提交进仓库。
- 包内有 `exports` 就必须显式导出 `./package.json` 与 `./locale/*.json`（当前已满足，改依赖时不要动）。

## 9. 未验证项

1. `AdbDaemonConnection` 的 Node `net.Socket` → WebStream 适配（§5.3）：只验证了「包能 import」，
   没有真实 TCP adbd 连接（本机 waydroid adb 端口不可达）。
2. `@yume-chan/stream-extra` 的 `WrapReadableStream`/`WrapWritableStream` 能否直接包 `net.Socket`
   —— 需 #3 运行时任务实测，备选 `node:stream` 的 `Readable.toWeb`。
3. 客户端软解路径（§7）的**运行期**表现未实测：已验证 bundle 可构建、无 worker/import.meta、
   WASM 以 data URI 内联；但主线程解码的 CPU/帧率、与 canvas 绘制的配合，本机无浏览器自动化环境，
   需 #6/#8 在真实页面验证。
4. `npm pack` 产物在真实 profile 中的 pnpm 安装（依赖是否随包正确落地）由 #8 安装冒烟覆盖。
5. **`tinyh264`（Apache-2.0）的许可声明义务**：它会被打进 `lib/client.js` 随包分发，必须在
   README/LICENSE 附第三方许可与版权声明（h264bsd 上游为 MIT/Apache 双许可形态，具体文本以
   `node_modules/tinyh264/LICENSE` 为准），交给 #7 文档任务汇总。
