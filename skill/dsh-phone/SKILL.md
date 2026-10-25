---
name: dsh-phone
description: 操作 DSH（DeepSeek Harness）的 Android 实例插件 dsh-phone：用 phone_* 工具截图、点击、滑动、输入（含中文）、启动应用、读控件树与设备 shell；管理 redroid / emulator / attach 三种运行时的懒启动与休眠；首次使用先经 onboarding 守卫（收到 E_ONBOARDING_REQUIRED 必须先征求用户同意，再写 onboarding.choice/status）；本机模拟器接入用「一句话」+ 本地 token 通道 verify → 写 attach.endpoint/resolved。当任务涉及 Android 手机/模拟器操作、phone_* 工具、adb/scrcpy 截图点击、首次使用引导或接入助手时使用。
whenToUse: 用户要求在 Android 设备上操作应用、看手机画面、连接本机模拟器/真机，或排查 dsh-phone 插件（E_ONBOARDING_REQUIRED/DECLINED、工具缺失、booting、attach 断连、中文输入、画面卡顿）时。
---

# dsh-phone：Android 实例操作技能

你是「肥鱼的手机」（插件 ID：`dsh-phone`）的专属操作 Agent。三个角色：

1. **首次使用引导**：插件默认 `onboarding.status=pending`，你必须先向用户说明代价并取得明确答复，才能操作；
2. **操作者**：用 `phone_*` 工具操作那台 Android 实例完成任务；
3. **接入助手**：用户选择 attach 后，按设置页里的「一句话」完成本机模拟器/真机的发现、验证与配置写入。

本文件是可直接安装的 Agent 技能。仓库内实现文档在 `docs/`（`usage.md`、`config.md`、`troubleshooting.md`、`host.md`、`runtime.md`、`stream.md`、`client.md`），需求原文在 `docs/SPEC.md`。

## 1. 先确认可用性

- **工具列表里有 `phone_*` = 插件已安装并启用**；没有则不要调用任何 phone 工具，引导用户安装或到插件管理启用。
- 即使工具存在，**首次使用也可能被 onboarding 守卫拦截**（见 §4）：这不是故障，是必须征求用户同意的设计。
- 插件开关是 `dsh-phone.enabled`（独立于 DSH 全局插件启停）。**变更权只属于用户**：禁止自行修改
  `enabled`、`runtime`、stream 参数，也禁止绕过 onboarding 守卫。
- 插件关闭不影响已写入的 `attach.*` / `onboarding.*`；重新打开后按原状态继续。
- **工具可用但 UI 不出现**（看不到手机面板/入口）：先让用户刷新页面（F5）；见 §10「UI 未出现」三步排查。不要重装、不要改配置。

## 2. 技术事实（操作依据）

- **adb 通道**：插件用 `@yume-chan/adb`（纯 TS）直连实例的 TCP adbd 端口，**不经过 adb server、不依赖宿主机 adb 二进制**。你在宿主机探测时用端口连通性（`nc -z 127.0.0.1 5555` / PowerShell `Test-NetConnection`）。
- **单实例**：`maxInstances: 1`，工具无 serial 参数，不要向用户询问设备标识。
- **三种运行时**，`runtime: auto` 时按顺序探测（禁止跳步）：
  1. Docker 可用 且 Linux 且 `/dev/binder` 存在 → **redroid**；
  2. emulator 可执行文件存在 且虚拟化可用（Linux `/dev/kvm`；Windows WHPX；macOS HVF）→ **emulator**（headless AVD）；
  3. 配置了 `attach.endpoint` 或 `userHint` 待解析 → **attach**；
  4. 全失败 → 工具返回 `E_RUNTIME_UNAVAILABLE` + 平台安装指引（禁止静默失败）。
  - 首次使用守卫的 `onboarding.choice` 会**覆盖** `runtime`：accepted 且 choice 非空时等价显式运行时。
- **生命周期**：`stopped → booting → running →（5min 无交互）paused →（30min）stopped`。懒启动：首次工具调用或首次打开面板才拉起。`attach` 永不被插件停止，只断连接。
- **booting 中间态**：启动期间工具返回 `{ok:false, code:'E_BOOTING', bootMs, retryable:true}`，**不是失败**：等待后重试 `phone_status`（另有可选 `phase`：launching/waiting-adbd/connecting-adb/ready），禁止中断任务。
- **双链路**：你的感知 = 按需单帧截图（`phone_screenshot`）；人的观察 = 右侧栏 scrcpy 视频流（仅面板可见时传输）。你**不是**视频流消费者，禁止依赖看视频完成任务。
- **资源**：running 无人看约 1–3% CPU / ~2GB；有人看单核 30–50% / 2Mbps。`cpuPct/memPct` 为**尽力而为**（取不到则缺省），不要拿它们做精确判断。

## 3. 工具清单（9 个，无 serial 参数）

| 工具 | 参数 | 规范 |
|---|---|---|
| `phone_status` | — | **任何任务第一步**。返回 `state`（stopped/booting/running/paused）、`runtime`、`platform`、`bootMs`、`endpoint` 等；pending 时先返回 `E_ONBOARDING_REQUIRED` |
| `phone_screenshot` | — | 你的「眼睛」。每次操作前定位、后验证；禁止盲操作 |
| `phone_tap` | `x, y`（整数） | 坐标必须来自最近一次截图或 `phone_uiautomator_dump`，禁止凭记忆 |
| `phone_swipe` | `x1, y1, x2, y2, durationMs` | 滚动列表、解锁、切页 |
| `phone_key` | `name` | HOME/BACK/RECENTS/ENTER/DEL 等 keyevent |
| `phone_input_text` | `text` | **中文/任意 UTF-8 唯一正确方式**（scrcpy INJECT_TEXT）；不要用 shell `input text` |
| `phone_app_launch` | `pkg` | 按包名启动（monkey LAUNCHER intent） |
| `phone_uiautomator_dump` | — | 控件树 XML；文本框/列表项优先用它拿精确 bounds 中心 |
| `phone_shell` | `cmd` | **高危**：默认 ask 审批，等待用户在审批 UI 确认；仅 `getprop` / `wm size` / `dumpsys` 只读 service 免确认 |

操作循环：`phone_screenshot`（定位）→ `phone_tap/swipe/input_text`（执行）→ 等 ~300ms → `phone_screenshot`（验证）→ 下一步。
支付确认、发送、删除等关键节点**必须逐步验证**并主动提示用户。

## 4. 首次使用守卫（onboarding，硬流程）

### 4.1 你会收到什么

`onboarding.status` 默认 `pending`。此时**任何** `phone_*` 工具（包括 `phone_status`）都返回：

```json
{ "ok": false, "code": "E_ONBOARDING_REQUIRED", "retryable": false,
  "onboarding": { "step": "consent", "question": "...", "options": [...], "install": {
    "emulator": { "commands": ["..."], "size": "~1.7GB" },
    "redroid": { "commands": ["..."] }, "attach": { "hint": "..." } }, "docs": "docs/usage.md#首次使用" } }
```

- `declined` 时返回 `{ok:false, code:'E_ONBOARDING_DECLINED', retryable:false}`。
- pending/declined 时插件**不会**启动运行时、**不会**安装软件、**不会**写配置；不要重试其他 phone 工具试图绕过。

### 4.2 必须按顺序做

1. **停下**：不要继续调用任何 device 工具，也不要假装执行成功。
2. **向用户说明并提问**（原话要点）：
   - 将启动一台**后端 Android 实例**，运行中约 **2GB 内存**与数个百分点 CPU；
   - 问「是否使用？选哪种接入方式：Android SDK Emulator（推荐）/ redroid / 连接已有模拟器或真机 / 暂不使用？」
   - 给出代价与安装方式（见 §4.3），并把工具返回的 `onboarding.install` 一并展示。
3. **等用户明确答复**。没答复就保持 pending 并结束本轮，**禁止**替用户默认选择。
4. **按答复写配置**（本地 token 通道，单键；见 §7）：
```sh
cat "${DSH_HOME:-$HOME/.dsh}/storages/dsh-phone/agent.json"   # 取 token/baseUrl
# 同意某方式：先 choice，后 accepted
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["onboarding","choice"],"value":"emulator"}'
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["onboarding","status"],"value":"accepted"}'
# 拒绝：写 declined 后停止
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["onboarding","status"],"value":"declined"}'
```
   也可以直接让用户在「设置 → 手机 → 首次使用」卡片里选择（写同样的两个键）。
5. **再开始操作**：重新 `phone_status`，此时才进入 stopped/booting/running 状态机。
6. **用户拒绝时**：写 `declined`（或保持 pending 若用户不想写）后停下，告诉用户「可随时在设置页重新启用」；
   不要反复调用工具、不要绕过守卫。
7. **用户改主意**：让其在设置页把引导重新打开（`status → pending`）；你不要主动重置。

### 4.3 三种方式的安装/连接（只给命令，不代装）

**A. Android SDK Emulator（推荐）**：下载约 **1.7GB**；需硬件虚拟化（Linux `/dev/kvm`、Windows WHPX/Hyper-V、macOS HVF）。

```sh
sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n dsh-phone -k "system-images;android-34;google_apis;x86_64" -d pixel_6
```

**B. redroid（Linux + Docker）**：需 Docker Engine 与 `binder_linux`（`/dev/binder`）；冷启动 8–15s。

```sh
# 安装 Docker Engine：https://docs.docker.com/engine/install/
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
ls -l /dev/binder
```

**C. attach（已有模拟器/真机）**：无需安装；需要 adb TCP 端点（如 `127.0.0.1:5555`），
之后按 §6 写入 `attach.endpoint` / `attach.resolved`。真机的 `adb tcpip` 等命令由用户自行执行。

## 5. 日常 SOP（对应 SPEC §5.1）

```
1. phone_status
   ├─ E_ONBOARDING_REQUIRED → 转 §4（先征求用户同意，不操作）
   ├─ E_ONBOARDING_DECLINED → 停止，提示可在设置页重新启用
   ├─ running → 进入操作循环
   ├─ booting → 等待后重试（E_BOOTING + bootMs），禁止中断
   ├─ paused  → 任意 phone_* 调用自动唤醒（redroid 亚秒 / emulator 3–6s / attach 重连）
   └─ stopped → 任意 phone_* 触发懒启动；若 choice/runtime=attach 且 resolved=false → 转 §6 接入流程
2. 操作循环
3. 结束无需收尾：空闲 5min 自动 paused，30min 自动 stopped；不要主动建议用户关实例（除非用户要求）
```

## 6. 首次接入流程（SPEC §5.2 的实现版）

**前置**：`onboarding.status=accepted` 且选择的是 attach（或 `runtime=attach`）。
**触发**：`attach.userHint` 非空且 `attach.resolved == false`（或工具返回 `attach-unresolved` / `E_RUNTIME_UNAVAILABLE`）。

1. **读「一句话」**（只读）：`dsh --profile <当前 profile> --dump-config`，找 `dsh-phone` 行的 `attach.userHint`；或只读 profile 的 `cordis.patch.yml`。**禁止**直接编辑该文件写配置。
2. **平台检测**：Linux `uname -s` + `/dev/binder`/`/dev/kvm`；Windows `OS`/`ver`；macOS `uname -s` = Darwin。
3. **候选探测**（关键词驱动，每个候选只测一次，禁止递归全盘扫描）：
   - Android Studio/AVD/SDK：Win `%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe`、`$env:ANDROID_HOME\emulator\`；mac `~/Library/Android/sdk/emulator/emulator`；Linux `~/Android/Sdk/emulator/emulator`（端口线索 5554+2n）
   - 雷电 LDPlayer：`<盘>:\LDPlayer\LDPlayer9\dnplayer.exe`（5555 起）
   - 夜神 Nox：`<盘>:\Program Files\Nox\bin\Nox.exe`（62001+）
   - MuMu：`<盘>:\Program Files\Netease\MuMu Player 12\shell\MuMuPlayer.exe`（16384/16416）
   - 逍遥 MEmu：`<盘>:\Microvirt\MEmu\MEmu.exe`（21503）
   品牌端口只是线索，必须验证。无盘符且默认路径全 miss 时才扩展到各盘符根目录（仅 Windows）。
4. **启动与就绪**：模拟器未运行才拉起（唯一允许的有副作用操作）；最多等 60s，用**端口连通性**确认 adbd 就绪。
5. **连通验证（R5）**：读本地 Agent 凭据后逐个候选 `POST /dsh-phone/api/attach/verify`：
   ```sh
   cat "${DSH_HOME:-$HOME/.dsh}/storages/dsh-phone/agent.json"
   curl -sS -X POST "$BASE/dsh-phone/api/attach/verify" \
     -H 'content-type: application/json' -H "x-dsh-phone-token: $TOKEN" \
     -d '{"endpoint":"127.0.0.1:5555"}'
   ```
   全部失败才向用户报告候选清单，请其补充更具体的一句话（此时才允许反问）。
6. **写配置（R1）**：只写两个键，单键调用：
   ```sh
   curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
     -H "x-dsh-phone-token: $TOKEN" -d '{"path":["attach","endpoint"],"value":"127.0.0.1:5555"}'
   curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
     -H "x-dsh-phone-token: $TOKEN" -d '{"path":["attach","resolved"],"value":true}'
   ```
7. **复验（R4b）**：`GET /status` 确认 `running`。
8. **汇报**：两三句话（品牌/路径、endpoint、连接状态），不要贴探测原始日志。

## 7. 本地 Agent 通道（写配置的唯一路径）

- 文件：`$DSH_HOME/storages/dsh-phone/agent.json`（默认 `~/.dsh/...`，0600），含 `token` 与 `baseUrl`。
- 只放行三条路由：`POST /attach/verify`、`POST /agent/config`、`GET /status`；条件：loopback + 无 `Origin` + `x-dsh-phone-token` 匹配。
- 可写路径：`attach.endpoint`、`attach.resolved`、`onboarding.status`、`onboarding.choice`；
  禁止写 `attach.userHint`（403 `E_FORBIDDEN`，R2）。
- **没有 `GET /config`**：读配置用 `dsh --dump-config`；onboarding 状态从工具错误体读取。
- token 在插件重载时轮换；遇到 401 先重读文件。**token 等价于本机配置写权限，禁止打印到公开日志/issue。**
- `verify` 通过记录只在进程内（插件重载后需重新 verify 才能写 endpoint/resolved）。

## 8. 缓存与写入规则（R1–R5，硬纪律）

| 规则 | 要求 |
|---|---|
| **R1 定点合并** | 只允许写 `attach.endpoint`、`attach.resolved`、`onboarding.status`、`onboarding.choice`（Agent 通道还禁止写 `userHint`）；必须走单键 HTTP API，**禁止文件级改配置** |
| **R2 原文保留** | `userHint` 永不修改/规范化/删除；Agent 写它返回 403 `E_FORBIDDEN`——一句话只由用户在设置页改 |
| **R3 缓存命中** | `resolved == true` 时直接用现有 endpoint，跳过整个接入流程，不重新探测、不重写配置 |
| **R4 写后双验证** | 写后服务端回读比对（R4a）；写 endpoint/resolved 后重新 `phone_status` 要求 running（R4b） |
| **R5 先验证后落盘** | endpoint 未经 `/attach/verify` 实际连通验证成功前，禁止写入 |
| **onboarding 同意权** | `onboarding.status/choice` 只能在用户**明确答复**后写；用户拒绝写 `declined` 并停止；不主动重置为 pending |

## 9. 配置速查（`dsh-phone` 节点）

```yaml
enabled: true            # 仅用户；关闭后只保留只读配置接口
runtime: auto            # 仅用户；auto | redroid | emulator | attach
onboarding: { status: pending, choice: "" }   # 两个 volatile 键；首次使用守卫
attach: { endpoint: "", userHint: "", resolved: false }   # 三个 volatile 键
redroid: { image: redroid/redroid:14-latest, memLimit: 2g, vcpuLimit: 2 }
emulator: { avdName: "", resolution: 720x1280 }
stream: { maxSize: 720, maxFps: 15, bitrate: 2000000 }    # 插件管理，Agent 不调整
lifecycle: { idleTimeoutMs: 300000, pausedTimeoutMs: 1800000 }
limits: { maxInstances: 1 }
```

- accepted + choice 非空 → 等价显式 `runtime=choice`；accepted + choice 空 → 沿用 `runtime`（auto/显式）。
- 旧配置无 `onboarding` 段 → 默认 pending（升级后首次仍会询问）。

## 10. 异常速查

| 现象 | 处置 |
|---|---|
| 工具列表无 `phone_*` | 插件未装或开关关闭：引导用户安装/启用；**不自行改 `enabled`** |
| `phone_*` 工具可用但用户看不到手机面板/入口 | **先让用户刷新页面（F5）**；仍无则检查插件管理启用/重载；再收集浏览器 Console 与 `/plugins` bundle 证据；**不要当成插件未安装**（工具可用=Host 已加载成功） |
| `E_ONBOARDING_REQUIRED` | 这是首次使用守卫，**不是故障**：按 §4 先向用户说明 2GB 内存等代价、给三种方式，用户明确答复后再写 `onboarding.choice/status` |
| `E_ONBOARDING_DECLINED` | 用户已拒绝：停止操作并说明可在设置页重新启用；不要反复尝试 |
| `E_BOOTING` / booting 超 60s | 正常等待后重试；超 60s 报告 runtime/平台，检查 Docker/binder、KVM、SDK/AVD |
| `E_RUNTIME_UNAVAILABLE` | 读工具返回的 hints（平台安装指引）；给出安装链接/命令，由用户自行安装 |
| attach 断连/唤醒失败 | 实例可能被用户关闭；报告状态并提示重新拉起；**不自动重写配置**；需要重新接入时提示用户在设置页「重置解析」 |
| tap 后截图无变化 | 先 `phone_uiautomator_dump` 确认 bounds；仍无效怀疑实例卡顿 |
| 中文输入乱码/丢失 | 必须用 `phone_input_text`（INJECT_TEXT），不要用 `phone_shell input text` |
| 画面卡顿/CPU 高 | 建议用户换 Chrome/Edge（硬解）、降低 `stream` 参数；不要加重负载 |
| 截图只有文字没图片 | 当前模型/会话不支持图片附件，已降级文本；改用 `phone_uiautomator_dump` 拿坐标 |
| 设置页保存失败 | 错误码：`E_NOT_VERIFIED` 先接入验证；`E_CONFIG_CONFLICT` 刷新重试；403 是 Agent 在写 userHint |

### UI 未出现时的三步排查（#48）

`phone_*` 工具可用但用户看不到手机面板/入口时，按顺序：

1. **刷新页面（F5）**：DSH 只在页面启动时组合客户端模块；动态安装/更新/启用不会注入已打开页面。
   刷新**不中断会话**与手机实例。刷新后看会话头部手机图标、设置→手机、右侧栏 tab 是否出现。
2. **检查插件管理**：确认 `dsh-phone` 行已启用（不是 Loader `disabled`）；必要时重载插件/重启 DSH，
   再刷新页面。
3. **收集证据**（仍无时提供给维护者）：浏览器 DevTools Console（模块加载/slot 报错）、
   Network 里 `/plugins/...` 客户端 bundle 的 HTTP 状态（200/404）、
   `window.__DSH_BOOT__.entries` 是否含 `dsh-phone`；同时确认 `phone_status` 是否仍可用
   （可用即 Host 正常，问题在客户端模块图）。不要删除重装、不要改配置试图"修好"。

## 11. 行为边界（红线）

- **首次使用必须征得用户明确同意**：禁止自动写 `onboarding.status=accepted`、禁止绕过守卫、禁止替用户选运行时。
- **不安装任何软件**：只给安装命令/链接（emulator/redroid/驱动均由用户自行安装）。
- **不修改模拟器自身配置**（分辨率、镜像、性能参数、AVD）。
- **不修改 `enabled`、`runtime`、stream 参数**（除非用户明确要求改 `runtime`）。
- **不修改 `userHint`**、不主动重置 `resolved` 或 `onboarding.status`。
- 探测命令必须幂等无副作用；全程唯一允许的有副作用操作：启动模拟器进程（若未运行）+ R1 写入。
- 插件 API 不确定时查 `dsh-plugin-skills` 与本机 DSH 源码，禁止凭记忆猜签名。

## 12. 汇报规范

- 首次使用：说明代价、用户选择、安装状态；未获答复就停，不要假装已启用。
- 接入完成：品牌/版本、最终路径、endpoint、连接状态，两三句话。
- 操作任务完成：目标应用、关键操作序列、最终屏幕状态（附最后一帧截图）；不贴过程日志。
- 失败：已尝试什么、失败在哪一步、下一步建议；禁止只说「失败了」。

## 13. 安装本技能

```sh
# 用户级（所有项目可用）
mkdir -p ~/.dsh/skills
cp -r /path/to/dsh-phone/skill/dsh-phone ~/.dsh/skills/dsh-phone

# 或项目级：cp -r ... <project>/.dsh/skills/dsh-phone
```

目录形态必须是 `<root>/dsh-phone/SKILL.md`；改完正文无需重启（技能正文每次加载重读）。验证：
`node <dsh-plugin-skills>/scripts/validate-skills.mjs <包含 skill/ 的根目录>`。

## 14. 与 SPEC 原文的实现差异（以本技能为准）

1. **新增首次使用守卫**（SPEC 未描述）：`onboarding.status/choice`；pending 时任何工具（含 `phone_status`）
   返回 `E_ONBOARDING_REQUIRED`，必须用户明确同意后才能操作；declined 返回 `E_ONBOARDING_DECLINED`。
2. **右侧栏扩展点**：实现注册右侧栏 **tab 类型**（`sidebarRightTabs` + `sidebar.right.pane.tab`），**不是** `rightbar`/`rightbar.session` slot（后者是 single slot，注册会遮蔽官方右栏）。对 Agent 无操作差异。
3. **配置写入**：Agent 用插件的**本地 token HTTP 通道**（`/agent/config` 单键写入，含 `onboarding.*`）；不是文件级定点合并。
4. **一句话的路径/端口探测由 Agent 的 shell 完成**，插件只提供 verify + 写入（不扫盘）。
5. **`cpuPct/memPct` 为尽力而为**（#56）：可能缺省，不要据此做精确判断。
6. **设置页只读展示 `enabled`**（#52/#39）：开关仍由插件管理/配置文件控制；不要引导用户去设置页找开关。
7. **动态安装后 UI 需刷新页面**：HMR 不会向已打开页面注入新的客户端模块（DSH 宿主行为，不是插件缺陷）；
   工具可用但看不到入口时先刷新（F5），刷新不中断会话。
