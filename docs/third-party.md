# 第三方依赖与许可

> 本项目代码以 **MIT** 发布，见 [LICENSE](../LICENSE)。本文件列出随插件分发的第三方组件、
> 仅开发期组件，以及运行期下载但不随包分发的组件。依赖版本与来源的完整记录见
> [dependencies.md](dependencies.md)。

## 1. 随插件分发的运行时依赖

用户 `dsh plugin add` 时，这些包会作为 dsh-phone 的 `dependencies` 安装进 profile；
其中客户端软解代码（`tinyh264`）会被打进 `lib/client.js`。

| 包 | 版本 | 许可 | 用途 | 上游 |
|---|---|---|---|---|
| `@yume-chan/adb` | `^2.6.4` | MIT | Tango ADB：纯 TS 直连 TCP adbd | <https://github.com/yume-chan/ya-webadb> |
| `@yume-chan/stream-extra` | `^2.6.1` | MIT | Web Streams 工具 | 同上 |
| `@yume-chan/scrcpy` | `^2.3.0` | MIT | scrcpy 协议/选项/控制消息 | 同上 |
| `@yume-chan/adb-scrcpy` | `^2.3.2` | MIT | 推送 scrcpy-server、起视频/控制通道 | 同上 |
| `tinyh264` | `^0.0.7` | **Apache-2.0** | 浏览器 WASM 软解兜底；**代码内联进 `lib/client.js`** | <https://github.com/udevbe/tinyh264> |

> **Apache-2.0 义务**：`tinyh264` 的代码与 wasm（base64 data URI）会随 `lib/client.js` 一起分发。
> 再分发时必须保留其版权与许可声明；完整许可文本见
> <https://www.apache.org/licenses/LICENSE-2.0>，版权与 NOTICE 以 `node_modules/tinyh264` 包内文件为准。
> 本项目不修改 `tinyh264` 源码。

## 2. 由宿主提供的 peer 依赖（不随插件安装）

| 包 | 版本区间 | 许可 | 说明 |
|---|---|---|---|
| `@deepseek-ai/dsh-tools` | `>=0.2.1-rc.2 <0.3.0` | MIT | `defineTool` 等工具契约，运行时用宿主那份 |
| `@deepseek-ai/schemastery` | `~3.18.5` | MIT | `Config` schema |
| `@deepseek-ai/cordis` | `~4.0.5` | MIT | Context / 插件生命周期 |

React 由 DSH Web 平台通过 `factory(require)` 提供，不随本插件打包。

## 3. 仅开发/构建期依赖（不进 tarball）

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| `typescript` | `^5.7.0` | Apache-2.0 | `tsc --noEmit` |
| `esbuild` | `^0.25.0` | MIT | Host 逐文件转译 + Client 单文件 bundle |
| `@types/node` / `@types/react` | — | MIT | 类型声明 |
| `@deepseek-ai/*` | 同宿主 | MIT | 本地 typecheck/test 解析 |

## 4. 运行期下载、不随包分发：scrcpy-server

| 组件 | 版本 | 许可 | 获取 |
|---|---|---|---|
| scrcpy-server | **v3.3.3** | **Apache-2.0**（Genymobile/scrcpy） | `node scripts/fetch-scrcpy-server.mjs`，或手动放 `assets/scrcpy-server.jar` |

- 上游：<https://github.com/Genymobile/scrcpy>
- 官方资产：<https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3>
- sha256：`7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`
- **不提交仓库、不随 npm 包分发**：它不是 npm 包、体积与平台属性不适合打包，且许可与 MIT 代码分开管理。
- 许可文本随上游发行版提供；再分发 jar 时请一并保留 scrcpy 的 LICENSE/NOTICE。

## 5. 许可兼容性说明

- 本项目 MIT 与上述 MIT / Apache-2.0 组件兼容；Apache-2.0 不是 copyleft，不要求本项目开源衍生作品。
- Apache-2.0 要求：保留版权/许可声明、若修改文件需注明、保留 NOTICE（上游有则保留）。
- 本仓库没有修改任何第三方源码；`tinyh264` 仅作为依赖被打包，scrcpy-server 原样下载与推送。

## 6. 复核方式

```sh
npm ls --all | head -60
for p in @yume-chan/adb @yume-chan/stream-extra @yume-chan/scrcpy @yume-chan/adb-scrcpy tinyh264; do
  node -e "const p=require('./node_modules/$p/package.json'); console.log(p.name, p.version, p.license)"
done
node scripts/fetch-scrcpy-server.mjs --check
```
