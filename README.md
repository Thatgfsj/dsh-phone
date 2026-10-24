# dsh-phone

> 肥鱼的手机：给 DeepSeek Harness（DSH）提供一台运行在后端、经浏览器右侧栏呈现的 Android 实例，并注册 9 个 `phone_*` 工具供 Agent 直接操作。

[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![files ≤1000 lines](https://img.shields.io/badge/file-%E2%89%A41000%20lines-brightgreen)](CONTRIBUTING.md)

> **状态：Host 半边已实现**（[#4](https://github.com/Thatgfsj/dsh-phone/issues/4)）：配置 schema、PhoneService、9 个 `phone_*` 工具、`/dsh-phone/api/*` 路由；运行时/ADB（[#3](https://github.com/Thatgfsj/dsh-phone/issues/3)）与 scrcpy 视频流（[#5](https://github.com/Thatgfsj/dsh-phone/issues/5)）已合并，右侧栏客户端与真机验收仍在后续 issue。Host 实现细节与偏差见 [docs/host.md](docs/host.md)，需求原文见 [docs/SPEC.md](docs/SPEC.md)。

## 目标能力

- **9 个 `phone_*` 工具**：`phone_status` / `phone_screenshot` / `phone_tap` / `phone_swipe` / `phone_key` / `phone_input_text` / `phone_app_launch` / `phone_uiautomator_dump` / `phone_shell`。
- **三种运行时 + auto 探测**：redroid（Docker 容器）/ Android SDK Emulator（KVM / WHPX / HVF）/ attach（用户本机模拟器或真机）。
- **懒启动与分级休眠**：首次工具调用或首次打开面板才拉起实例；5 分钟无交互进 paused，30 分钟或资源紧张进 stopped。
- **双链路解耦**：Agent 只看按需单帧截图（约 100–300ms、零持续开销）；人看 scrcpy H.264 视频流（720p / 15fps / 2Mbps，仅面板可见时传输，Host 零转码）。
- **首次接入「一句话」解析**：用户填一句话（如「模拟器在 D:\Android\Sdk」），插件自动发现可执行文件路径与 adb TCP 端口，连通验证后只定点写入 `attach.endpoint` 与 `attach.resolved` 两个字段。

## 配置（SPEC §6.1）

`dsh-phone` 节点（`enabled` 与 `runtime` 仅用户可改；`attach.*` 三键为 volatile，可由设置页/接入流程实时写入）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关（关闭时只保留设置页只读配置接口，不注册工具与视频流） |
| `runtime` | `auto` | `auto｜redroid｜emulator｜attach`，auto 按 SPEC §3.1 决策树 |
| `attach.endpoint` | `""` | 已解析的 adb 端点，如 `127.0.0.1:5555`（volatile） |
| `attach.userHint` | `""` | 用户的一句话，原文保留（volatile） |
| `attach.resolved` | `false` | 解析完成哨兵（volatile；重置权属用户） |
| `redroid.image` | `redroid/redroid:14-latest` | redroid 镜像 |
| `redroid.memLimit` / `redroid.vcpuLimit` | `2g` / `2` | 容器资源上限 |
| `emulator.avdName` / `emulator.resolution` | `""` / `720x1280` | 空 avdName 表示首次自动创建 |
| `stream.maxSize` / `maxFps` / `bitrate` | `720` / `15` / `2000000` | 视频参数（插件管理，Agent 不调整） |
| `lifecycle.idleTimeoutMs` / `pausedTimeoutMs` | `300000` / `1800000` | 5min 无交互→paused；30min→stopped |
| `limits.maxInstances` | `1` | 首版单实例 |

配置写入只走 `ctx.settings.mutate`（R1/R4）：只允许 `attach.endpoint｜attach.resolved｜attach.userHint`
三个键，revision 冲突重试一次，写后回读双验证；插件不读写 `cordis.patch.yml`。

## Host HTTP 接口

前缀 `/dsh-phone/api`，全部经 `ctx.connection.requestRejection` 同源鉴权，响应
`{ok:true,value}` / `{ok:false,error:{code,message,retryable}}`，config/status/screenshot 为 `no-store`：

| 方法/路径 | 用途 |
|---|---|
| `GET /status` | 实例状态（state/runtime/platform/bootMs/endpoint…） |
| `GET /config` | 当前配置快照 + settings revision |
| `POST /config` | 单键写入（`attach.endpoint｜resolved｜userHint`），R4 回读 + 复验 |
| `POST /attach/verify` | 连通验证（connect + `getprop ro.product.model`），不落盘（R5） |
| `POST /agent/config` | 本地 Agent 通道：loopback + 无 Origin + `x-dsh-phone-token`（见下） |
| `GET /screenshot` | 按需单帧 PNG（Agent 截图通道） |

操作 Agent 无法使用浏览器 cookie，因此插件在 `$DSH_HOME/storages/dsh-phone/agent.json`（0600）
写入 `{token, baseUrl}` 供其调用 `/dsh-phone/api/agent/config`：先 `POST /attach/verify` 验证端点（R5），
再写 `attach.endpoint` 与 `attach.resolved`（R1 单键；Agent 通道**禁止**写 `attach.userHint`，R2），
最后 `GET /status` 复验（R4b）；插件卸载时删除
token 文件、重载轮换。候选路径/端口探测仍由 Agent 的 shell 完成，插件不扫盘。完整 curl 示例见
[docs/host.md](docs/host.md) §5.1。

WS `/dsh-phone/stream` 由 stream 层 `createStreamUpgradeRoute` 注册（`DPH1` 帧头，见
[docs/protocol.md](docs/protocol.md)）。

## 安装

> 尚未发布，当前不可安装；以下为预期用法，实现完成后随 README 更新。

```sh
git clone https://github.com/Thatgfsj/dsh-phone.git
cd dsh-phone
npm install
npm run build
dsh plugin --profile web add .
```

要求：DSH `>=0.2.1-rc.2 <0.3.0`；Node `>=20`。

## 目录结构

```
.
├── docs/            # SPEC.md（需求原文）与实现、校准文档
├── locale/          # 中文 / 英文展示元数据（meta.title / meta.description）
├── scripts/         # 构建脚本与仓库自检脚本
├── src/             # 插件源码（Host / client / runtime / adb / stream / tools）
├── tests/           # node --test 单测
├── cordis.patch.yml # bundle 配置层（insert dsh-phone）
├── icon.svg         # 插件图标（顶层 icon 字段）
└── package.json     # DSH 插件元数据（dsh.bundle / dsh.client / engines）
```

## 开发

```sh
npm install                      # 安装 devDependencies（含 @deepseek-ai/cordis、dsh-tools、schemastery）
npm run check                    # typecheck + node --test + 单文件行数检查
npm run build                    # -> lib/（构建产物，不提交）
node scripts/check-file-lines.mjs
```

Host 单测在 `tests/host/`（schema/工具参数/service 单飞与 booting/审批/HTTP R1-R5/配置写入），
不依赖真机；覆盖矩阵见 [docs/host.md](docs/host.md) §8。

- 构建：Host 逐文件 esbuild 转译（`bundle: false`，`outbase src`），Client 打包为 `window.__ModuleLoader__.load` 包装的 `lib/client.js`；当前没有源码时构建直接成功退出。
- 测试：`node --test`，测试文件放 `tests/`。

## 已知限制

- 首版单实例（`maxInstances: 1`），所有工具无 serial 参数。
- 本机验证环境没有 Docker：redroid 适配器以单测覆盖为主，未做集成验证。
- 需要宿主机具备 Docker（binder）/ Android SDK Emulator / 可连通的本机模拟器之一；插件不安装任何软件。
- **Host 侧未实现**：`PhoneStatus.cpuPct/memPct` 采样、`phone_screenshot` 的模型图片能力探测、
  一句话候选路径自动扫描（按 #4 约定由操作 Agent 的 shell 完成，插件只提供 verify + 配置写入）。
- 真机端到端（attach 实际连通、scrcpy 视频流、审批 UI）仍未验证；详见 [docs/host.md](docs/host.md) §7。

## 参与贡献

任何改动都必须先开 Issue、再开 PR；CI 只在推 `v*` tag 或手动触发时运行。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

## 协议

MIT，见 [LICENSE](LICENSE)。