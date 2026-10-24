# dsh-phone

> 肥鱼的手机：给 DeepSeek Harness（DSH）提供一台运行在后端、经浏览器右侧栏呈现的 Android 实例，并注册 9 个 `phone_*` 工具供 Agent 直接操作。

[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![version](https://img.shields.io/badge/version-v0.1.0-blueviolet)](#版本与状态)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![files ≤1000 lines](https://img.shields.io/badge/file-%E2%89%A41000%20lines-brightgreen)](CONTRIBUTING.md)

## 版本与状态

**v0.1.0（已发布）**：三运行时、9 个工具、scrcpy 视频流、右侧栏面板与设置页均已实现并合并。发布说明见 [CHANGELOG.md](CHANGELOG.md#v010---2026-10-25)。

- 需求原文：[docs/SPEC.md](docs/SPEC.md)（**禁止改写**）。实现与需求的差异、未验证项见 [docs/host.md](docs/host.md)、[docs/runtime.md](docs/runtime.md)、[docs/stream.md](docs/stream.md)、[docs/client.md](docs/client.md)。
- 集成点校准（DSH 0.2.1-rc.2 本机源码证据）：[docs/calibration.md](docs/calibration.md)；架构与协议契约：[docs/architecture.md](docs/architecture.md)、[docs/protocol.md](docs/protocol.md)。

## 能力

- **9 个 `phone_*` 工具**：`phone_status` / `phone_screenshot` / `phone_tap` / `phone_swipe` / `phone_key` / `phone_input_text` / `phone_app_launch` / `phone_uiautomator_dump` / `phone_shell`。工具出现在 Agent 工具列表 = 插件开关已打开。
- **三种运行时 + auto 探测**：redroid（Docker 容器）/ Android SDK Emulator（KVM / WHPX / HVF，headless AVD）/ attach（连接用户自己的模拟器或真机）。
- **懒启动与分级休眠**：首次工具调用或首次打开面板才拉起实例；5 分钟无交互 → `paused`，30 分钟或资源紧张 → `stopped`。`attach` 永不被插件停止。
- **双链路解耦**：Agent 只看按需单帧截图（约 100–300ms、零持续开销）；人看 scrcpy H.264 视频流（默认 720p / 15fps / 2Mbps，仅面板可见时传输）。Host 零转码；浏览器 WebCodecs 硬解，TinyH264 WASM 软解兜底。
- **右侧栏面板与设置页**：面板是右侧栏的一个 tab（不遮蔽官方右栏）；设置页维护「一句话」、显示解析状态、提供重置入口与「打开手机面板」按钮。
- **首次接入「一句话」**：用户填一句话（如「用的雷电模拟器，装在默认位置」），操作 Agent 用本地 token 通道完成探测、连通验证与**定点**配置写入。

## 平台与前置条件

| 平台 | 首选运行时 | 前置条件 |
|---|---|---|
| Linux | redroid（Docker） | Docker Engine；`binder_linux` 已加载（`/dev/binder` 存在） |
| Windows | Android SDK Emulator（WHPX） | Android Studio / SDK Emulator；开启「虚拟机平台 / Hyper-V」，BIOS 打开虚拟化 |
| macOS | Android SDK Emulator（HVF） | Android Studio / SDK Emulator（Hypervisor.framework 默认可用） |
| 任意 | attach（本机模拟器或真机） | 实例已在运行且 adb TCP 端口可达（如 `127.0.0.1:5555`） |

- `runtime: auto` 的探测顺序（不跳步）：redroid → emulator → attach → 失败并给出平台安装指引。显式配置 `runtime` 时跳过探测。
- Windows 下 WSL2 + redroid 属进阶路径，**不进入默认推荐**，仅在用户主动询问时提供指引。
- 插件**不安装任何软件**、**不修改模拟器自身配置**；前置条件不满足时只输出安装指引。

## 安装

**v0.1.0 已可用。** 要求：DSH `>=0.2.1-rc.2 <0.3.0`、Node `>=20`；宿主浏览器需支持 WebCodecs（Chrome / Edge 等），不支持时自动回退 TinyH264 软解。源码安装见下，tarball 安装见 [docs/install.md](docs/install.md) §2。

```sh
git clone https://github.com/Thatgfsj/dsh-phone.git
cd dsh-phone
npm install
npm run build                              # -> lib/（Host 逐文件转译 + Client 打包）
node scripts/fetch-scrcpy-server.mjs       # -> assets/scrcpy-server.jar（校验 sha256）
dsh plugin --profile web add .             # 目录安装，link 到当前 checkout
```

重启 DSH 后打开「设置 → 手机」。完整步骤（含临时 profile 验证、升级、卸载、离线安装）见 [docs/install.md](docs/install.md)。

## 首次接入（一句话）

1. 用户在「设置 → 手机」的「一句话」里描述模拟器位置（原文永久保留，插件不做规范化）。
2. 操作 Agent 读取这句话（`dsh --profile <profile> --dump-config` 中 `dsh-phone` 行的 `config.attach.userHint`），在宿主机做候选路径/端口探测（仅幂等只读命令 + 必要时启动模拟器）。
3. Agent 用本地通道完成 R5/R1/R4：

```sh
# 本地 Agent 凭据（插件加载时生成，0600；卸载/重载会轮换）
cat "${DSH_HOME:-$HOME/.dsh}/storages/dsh-phone/agent.json"   # -> {"token":"…","baseUrl":"http://127.0.0.1:3080"}
BASE=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.dsh/storages/dsh-phone/agent.json','utf8')).baseUrl)")
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.dsh/storages/dsh-phone/agent.json','utf8')).token)")

# 1) 先验证（R5，不落盘）
curl -sS -X POST "$BASE/dsh-phone/api/attach/verify" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"endpoint":"127.0.0.1:5555"}'

# 2) 单键写入（R1）；resolved=true 前当前 endpoint 必须在同一进程内已验证
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["attach","endpoint"],"value":"127.0.0.1:5555"}'
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["attach","resolved"],"value":true}'

# 3) 复验（R4b）
curl -sS "$BASE/dsh-phone/api/status" -H "x-dsh-phone-token: $TOKEN"
```

- Agent 通道**禁止**写 `attach.userHint`（403 `E_FORBIDDEN`，R2）——一句话只由用户在设置页修改。
- `attach.resolved == true` 时直接连现有 endpoint（R3），禁止重新探测/重写配置。
- 面板随时可接管操作；敏感操作（支付确认、发送/删除）前 Agent 应先提示用户。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `phone_status` | — | 任何任务第一步；返回 state/runtime/platform/bootMs/endpoint 等（`cpuPct/memPct` 当前未实现） |
| `phone_screenshot` | — | 单帧截图，图片内容块；附件不可用时降级文本 |
| `phone_tap` | `x, y` | 坐标必须来自最近一次截图或控件树 |
| `phone_swipe` | `x1, y1, x2, y2, durationMs` | 滚动、解锁、切页 |
| `phone_key` | `name` | HOME/BACK/RECENTS/ENTER/DEL 等 keyevent |
| `phone_input_text` | `text` | 支持中文（scrcpy INJECT_TEXT，非 shell `input text`） |
| `phone_app_launch` | `pkg` | 按包名启动（monkey LAUNCHER intent） |
| `phone_uiautomator_dump` | — | 控件树 XML，与截图构成双通道校验 |
| `phone_shell` | `cmd` | **默认 ask 审批**；仅 `getprop` / `wm size` / `dumpsys` 只读子集免确认 |

其中 `phone_status/phone_screenshot/phone_uiautomator_dump` 无参数；其余必填参数如上。`state=booting` 时工具返回可重试的 `E_BOOTING`（带 `bootMs`），不要当失败中断任务。

**首次使用守卫**：`onboarding.status` 为 `pending`/`declined` 时，9 个工具都返回
`E_ONBOARDING_REQUIRED`/`E_ONBOARDING_DECLINED`（`retryable:false`，pending 带 `onboarding` 提问与安装指引），
不触碰设备/运行时；用户明确答复后写 `onboarding.status`（+ `choice`）即放行。详见 [docs/usage.md](docs/usage.md#首次使用)。

## 配置

`dsh-phone` 配置节点（完整说明与变更权见 [docs/config.md](docs/config.md)）：

| 字段 | 默认值 | 变更权 |
|---|---|---|
| `enabled` | `true` | 仅用户；非 volatile，改动需重载插件 |
| `runtime` | `auto` | 仅用户；`auto｜redroid｜emulator｜attach` |
| `attach.endpoint` | `""` | **volatile**；接入流程验证后单键写入 |
| `attach.userHint` | `""` | **volatile**；仅用户在设置页写，原文保留 |
| `attach.resolved` | `false` | **volatile**；缓存锚点，重置权属用户 |
| `onboarding.status` | `"pending"` | **volatile**；首次使用守卫（pending/accepted/declined），旧配置无该段也按 pending |
| `onboarding.choice` | `""` | **volatile**；`""｜emulator｜redroid｜attach`，accepted 且非空时等价显式 runtime |
| `redroid.image` / `memLimit` / `vcpuLimit` | `redroid/redroid:14-latest` / `2g` / `2` | 用户（模拟器参数） |
| `emulator.avdName` / `resolution` | `""` / `720x1280` | 用户；空 avdName 表示首次自动创建 |
| `stream.maxSize` / `maxFps` / `bitrate` | `720` / `15` / `2000000` | 归插件管，Agent 不调整 |
| `lifecycle.idleTimeoutMs` / `pausedTimeoutMs` | `300000` / `1800000` | 用户 |
| `limits.maxInstances` | `1` | 固定（首版单实例） |

配置写入只走 `ctx.settings.mutate`（单键 + revision），落盘由 DSH `configEditor` 用 YAML Document 保留注释/顺序、原子写、失败回滚；插件**不**读写 `cordis.patch.yml`。

## 本地 HTTP 与 Agent 通道

前缀 `/dsh-phone/api`；浏览器请求经 `ctx.connection.requestRejection` 同源鉴权，响应 `{ok:true,value}` / `{ok:false,error:{code,message,retryable}}`，config/status/screenshot 一律 `no-store`：

| 方法/路径 | 用途 |
|---|---|
| `GET /status` | 实例状态；onboarding pending/declined → 200 结构化 `E_ONBOARDING_*`（不碰设备） |
| `GET /config` | 配置快照（含 onboarding）+ settings revision（浏览器/设置页） |
| `POST /config` | 单键写入（浏览器设置页；支持 attach 三键 + onboarding 两键） |
| `POST /attach/verify` | 连通验证（connect + `getprop ro.product.model`），不落盘（R5） |
| `POST /agent/config` | 本地 Agent 单键写入（loopback + 无 Origin + `x-dsh-phone-token`） |
| `GET /screenshot` | 按需单帧 PNG |

- Agent 通道文件：`$DSH_HOME/storages/dsh-phone/agent.json`（默认 `~/.dsh/...`，权限 0600；插件卸载即删除）。token 只在本机 loopback 且无 `Origin` 时生效，重载后轮换。
- WS `/dsh-phone/stream`：首条 `hello`，下行 `DPH1` 8 字节头 + H.264 Annex-B，详见 [docs/protocol.md](docs/protocol.md)。
- 安全：只监听 loopback；不提供跨机访问面；不打印完整 shell 命令。

## 缓存与写入规则（SPEC §6.2）

| 规则 | 实现 |
|---|---|
| **R1 定点合并** | 允许写 `attach.endpoint` / `attach.resolved` / `attach.userHint` 与 `onboarding.status` / `onboarding.choice`；其余路径 400 `E_BAD_PATH`（Agent 通道仍禁写 userHint） |
| **R2 原文保留** | `userHint` 永不规范化/删除；本地 Agent 通道写它返回 403 `E_FORBIDDEN` |
| **R3 缓存命中** | `resolved=true` 直接连现有 endpoint，不重新探测、不重写配置 |
| **R4 写后双验证** | 写后 describe 回读比对；写 endpoint/resolved 后再取 `phone_status` 要求 running |
| **R5 先验证后落盘** | 写 endpoint 前必须 `/attach/verify` 成功（进程内记录），未验证 409 `E_NOT_VERIFIED` |

## 错误码摘要

| code | 场景 | 可重试 |
|---|---|---|
| `E_BOOTING` | 实例启动/唤醒中（带 `bootMs`） | 是 |
| `E_RUNTIME_UNAVAILABLE` | 三种运行时均不可用，附平台安装指引 | 否 |
| `E_DEVICE_COMMAND` | 设备命令/截图/输入失败 | 是 |
| `E_TIMEOUT` | ADB/操作超时 | 是 |
| `E_DEVICE_DISCONNECTED` | 写配置后复验未 running；或运行中断连 | 是 |
| `E_NOT_VERIFIED` | 未通过 `/attach/verify` 就写 endpoint/resolved=true | 否 |
| `E_CONFIG_CONFLICT` | settings revision 冲突（自动重试一次后） | 是 |
| `E_BAD_PATH` / `E_BAD_REQUEST` | 写入路径不在白名单 / 请求非法 | 否 |
| `E_FORBIDDEN` | Agent 通道试图写 `userHint` | 否 |
| `E_AUTH` / `E_ORIGIN` / `E_NO_WEB` | 未认证 / 跨站 / 无 web carrier 或插件关闭 | 否 |
| `E_STREAM_START_FAILED` | scrcpy server 启动/推包失败 | 是 |

## 目录结构

```
.
├── docs/            # 需求原文、校准、架构/协议、实现说明与用户文档
├── locale/          # 中英文展示元数据（meta.title / meta.description）
├── scripts/         # 构建、行数检查、scrcpy-server 下载
├── src/             # Host（config/http/phone/tools）+ runtime/adb + stream + client
├── tests/           # node --test（host/runtime/stream/client）
├── cordis.patch.yml # bundle 配置层（insert dsh-phone）
├── icon.svg         # 插件图标
└── package.json     # DSH 插件元数据（dsh.bundle / dsh.client / engines）
```

## 开发

```sh
npm install
npm run check     # tsc --noEmit + node --test + 单文件行数（1000 硬线）
npm run build     # Host 逐文件 esbuild 转译 + Client __ModuleLoader__ 单文件 bundle
npm pack --dry-run
```

文档随代码同 PR 更新；`docs/SPEC.md` 禁止改写。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

## 已知限制

- **首版单实例**（`maxInstances: 1`）：工具无 serial 参数，不支持多设备。
- **未在本机端到端验证**：本机无 Docker、无 emulator 包/AVD、attach 端口不可达。redroid、emulator、真机 attach、scrcpy 视频流、审批 UI、真实浏览器渲染均只有单测/静态验证；详见 [docs/runtime.md](docs/runtime.md) §6、[docs/stream.md](docs/stream.md) §8、[docs/client.md](docs/client.md) §6。
- **`cpuPct/memPct` 未实现**：`phone_status` 中这两个字段当前始终缺省。
- **`phone_screenshot` 的模型图片能力**：仅捕获 `attachments.saveImage` 失败并降级文本，未探测模型路由是否接受图片。
- **一句话的候选路径/端口探测由操作 Agent 完成**：插件不扫盘，只提供 `/attach/verify` 与单键写入。
- **`enabled` 开关不在设置页表单里**：它非 volatile；关闭插件请用「插件管理」禁用该行，或在 profile 配置中改 `enabled: false` 后重载（见 [docs/config.md](docs/config.md)）。
- **scrcpy-server jar 不随包分发**：需运行 `node scripts/fetch-scrcpy-server.mjs`（或设 `DSH_PHONE_SCRCPY_SERVER` 指向已有 jar）。离线/镜像可用性见 [docs/install.md](docs/install.md)。
- Windows WSL2 + redroid 属进阶路径；Windows/macOS 的 emulator 参数未在本机验证。

## 文档

| 想做什么 | 读哪个 |
|---|---|
| 安装 / 升级 / 卸载 / 临时 profile 验证 | [docs/install.md](docs/install.md) |
| 日常操作 SOP 与首次接入流程 | [docs/usage.md](docs/usage.md) |
| 配置字段、变更权、落盘位置 | [docs/config.md](docs/config.md) |
| 报错与常见现象 | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 第三方依赖与许可 | [docs/third-party.md](docs/third-party.md) |
| 给 Agent 的可安装技能 | [skill/dsh-phone/SKILL.md](skill/dsh-phone/SKILL.md) |
| 需求 / 架构 / 协议 / 校准 | [docs/SPEC.md](docs/SPEC.md) / [docs/architecture.md](docs/architecture.md) / [docs/protocol.md](docs/protocol.md) / [docs/calibration.md](docs/calibration.md) |

## 协议

代码 MIT，见 [LICENSE](LICENSE)。第三方组件许可（含随 `lib/client.js` 分发的 Apache-2.0 `tinyh264`、运行时下载的 Apache-2.0 scrcpy-server）见 [docs/third-party.md](docs/third-party.md)。