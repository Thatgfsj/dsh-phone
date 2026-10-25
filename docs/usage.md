# 使用指南

> 面向两类读者：**操作 Agent**（按 [skill/dsh-phone/SKILL.md](../skill/dsh-phone/SKILL.md) 的 SOP 工作）
> 与**人类用户**（首次选择接入方式、在设置页填一句话、在右侧栏看手机）。
> 需求原文见 [SPEC.md](SPEC.md) §4–§5；实现细节见 [host.md](host.md)、[stream.md](stream.md)、[client.md](client.md)、[config.md](config.md)。

## 1. 首次使用（onboarding 守卫）

插件默认 `onboarding.status = pending`：**在用户明确同意并选择接入方式之前，任何 `phone_*` 工具（包括
`phone_status`）都不会启动运行时、不碰设备、不安装软件、不写配置**。

### 1.1 守卫行为

| 状态 | 工具行为 |
|---|---|
| `pending` | 返回 `{ok:false, code:'E_ONBOARDING_REQUIRED', retryable:false, onboarding:{step,question,options,install,docs}}`；`install` 含 emulator/redroid/attach 三种方式的命令与体积提示 |
| `declined` | 返回 `{ok:false, code:'E_ONBOARDING_DECLINED', retryable:false}`；用户可在设置页重新打开引导 |
| `accepted` + `choice` 非空 | 允许操作，等价显式 `runtime = choice`（跳过 auto 决策树） |
| `accepted` + `choice` 为空 | 允许操作，沿用 `runtime` 配置（`auto` 或显式值） |

- `GET /dsh-phone/api/status` 在 pending/declined 时返回 200 + 同一结构化 onboarding 错误（面板展示引导，不报错）。
- 升级前没有 `onboarding` 段的旧配置会按默认值补为 `pending`，因此升级后首次仍会询问一次。
- **插件不代装**：安装命令只展示，必须由用户在自己的终端执行（SPEC §6.4）。

### 1.2 Agent 处理流程（收到 `E_ONBOARDING_REQUIRED` 时）

1. **先停下，向用户说明**：会启动一台后端 Android 实例，运行中约 **2GB 内存**与数个百分点 CPU；
   询问「是否使用？选哪种接入方式？」——不要跳过提问直接写配置。
2. **给出三种方式与代价**（含工具返回的 `install` 指引）：
   - **emulator（推荐，Win/macOS/Linux）**：需 Android SDK Emulator + 硬件虚拟化（Linux `/dev/kvm`、
     Windows WHPX/Hyper-V、macOS Hypervisor.framework）；下载约 **1.7GB**；首次启动 20–40s。
   - **redroid（Linux + Docker）**：需 Docker Engine 与 `binder_linux`（`/dev/binder`）；冷启动 8–15s；
     首次会拉取 `redroid/redroid:14-latest` 镜像（体积取决于镜像，未在本机验证）。
   - **attach（任意平台）**：连接用户已有的模拟器/真机，无需安装；需提供 adb TCP 端点。
3. **等用户明确答复后**才写配置（本地 token 通道，单键；见 §5）：
```sh
# 选择某种方式：先写 choice，再写 status=accepted
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["onboarding","choice"],"value":"emulator"}'
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["onboarding","status"],"value":"accepted"}'
# 用户拒绝：只写 declined，然后停止（后续工具会返回 E_ONBOARDING_DECLINED）
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["onboarding","status"],"value":"declined"}'
```
   也可让用户在「设置 → 手机」的首次使用卡片里自行选择。
4. **写入后再开始操作**：再次 `phone_status` 应进入正常状态机（stopped/booting/running）。
5. **用户拒绝时**：写入 `declined`（或用户不想写就保持 pending）后停下，说明「可随时在设置页重新启用」，
   不要反复调用工具、不要试图绕过守卫。

### 1.3 三种方式的安装/连接命令（由用户执行）

**A. Android SDK Emulator（推荐）**

```sh
# cmdline-tools 的 sdkmanager/avdmanager 需在 PATH 中（Android Studio 自带）
sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n dsh-phone -k "system-images;android-34;google_apis;x86_64" -d pixel_6
# Linux 另需 /dev/kvm；Windows 需开启「虚拟机平台 / Hyper-V」与 BIOS 虚拟化
```

装好后在设置页选择「Android SDK Emulator」并接受；插件会在首次工具调用时 headless 启动（可自动创建 AVD）。

**B. redroid（Linux + Docker）**

```sh
# 1) 安装 Docker Engine：https://docs.docker.com/engine/install/
# 2) 加载 binder 模块（重启后可能需重新加载）
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
ls -l /dev/binder        # 必须存在
```

装好后选择「redroid」；插件会按配置的镜像/资源上限运行容器（不修改宿主机 Docker 配置）。

**C. attach（已有模拟器/真机）**

```sh
# 模拟器：确认 adb 调试端口（多数为 127.0.0.1:5555 起）
nc -z 127.0.0.1 5555     # Windows: Test-NetConnection 127.0.0.1 -Port 5555
# 真机：用户自行开启 USB/无线调试（如 adb tcpip 5555），插件不执行该命令
```

选择「连接已有模拟器/真机」并接受后，按 §4「首次接入流程」写入 `attach.endpoint` / `attach.resolved`。

### 1.4 重新打开引导

设置页「首次使用」卡片提供重新选择/重新开启入口：把 `onboarding.status` 写回 `pending`（保留已选
`choice`）。Agent 不主动重置，只在用户要求时提示该入口。

## 2. 打开面板与设置页

1. 重启 DSH 后，打开「设置 → 手机」：
   - **首次使用卡片**：pending 时显示三种接入方式、安装命令与体积；选择后写 `onboarding.status/choice`；
   - 「一句话」：描述你的模拟器/真机在哪里（原文永久保留）；
   - 「解析状态」：显示 `attach.resolved` 与当前 `attach.endpoint`；
   - 「打开手机面板」：打开右侧栏的「手机」tab；
   - 「重置解析」：把 `attach.resolved` 置回 `false`（需用户确认；Agent 不会调用）。
2. 面板开启后：左侧是实时画面（WebCodecs 硬解，失败回退 TinyH264 软解），底部有 HOME/BACK/RECENTS/ENTER/DEL 按键，状态栏显示连接与解码状态。
3. **不可见即停流**：切走 tab、折叠右栏或页面不可见时，客户端立即断流；Host 在最后一个 viewer 离开 5s 后停止 scrcpy 会话（实例继续 running）。

## 3. 日常操作 SOP（对应 SPEC §5.1）

```
1. phone_status
   ├─ E_ONBOARDING_REQUIRED → 转 §1（先征求用户同意，不操作）
   ├─ E_ONBOARDING_DECLINED → 停止，提示可在设置页重新启用
   ├─ running → 进入操作循环
   ├─ booting → 等待后重试（工具已返回 E_BOOTING + bootMs，不要中断任务）
   ├─ paused  → 任意 phone_* 调用会自动唤醒（redroid 亚秒 / emulator 3–6s / attach 重连）
   └─ stopped → 任意 phone_* 调用触发懒启动；若 choice/runtime=attach 且 resolved=false → 转 §4 接入流程
2. 操作循环：phone_screenshot（定位）→ phone_tap/swipe/input_text（执行）
   → 等待约 300ms → phone_screenshot（验证）→ 下一步
3. 任务结束无需收尾：空闲 5 分钟自动 paused，30 分钟自动 stopped（attach 不断实例）
```

要点：

- **坐标必须来自证据**：最近一次截图，或 `phone_uiautomator_dump` 的 `bounds` 中心；禁止凭记忆猜。
- **中文输入**：只用 `phone_input_text`（scrcpy `INJECT_TEXT`），不要用 shell `input text`。
- **关键节点逐步验证**：支付确认、发送、删除等不可逆操作前先截图并在面板上提示用户。
- **`phone_shell` 默认 ask**：非白名单命令会弹出审批，等待用户确认；仅 `getprop` / `wm size` / `dumpsys` 只读子集免确认。
- **不要依赖视频流**：Agent 的感知链路是单帧截图，视频流只给人看（SPEC §3.6）。

## 4. 首次接入流程（SPEC §5.2 的实现版）

前置：`onboarding.status = accepted` 且选择的是 attach（或 `runtime=attach`）。
触发条件：`attach.userHint` 非空且 `attach.resolved == false`（或运行时报 `E_RUNTIME_UNAVAILABLE` / `attach-unresolved`）。

### 步骤 1 — 读「一句话」

Agent 没有浏览器 cookie，**不能**用 `GET /config` 读配置。用只读 CLI：

```sh
dsh --profile <当前 profile> --dump-config | grep -n -A 20 'dsh-phone'
# 找到 config.attach.userHint / endpoint / resolved
```

备选（同样是只读）：读 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里 `id: dsh-phone` 行的 `config.attach.userHint`。
**禁止**直接编辑该文件写配置（R1/R4/R5 会被绕过）。

### 步骤 2 — 平台检测（自己检测，不问用户）

Linux：`uname -s`、`ls -l /dev/binder /dev/kvm`；
Windows：`OS` 环境变量 / `ver`；
macOS：`uname -s` 为 Darwin。

### 步骤 3 — 关键词驱动候选探测

按一句话中的品牌/关键词选候选，**每个候选只测一次，禁止递归全盘扫描**：

| 关键词 | 候选路径 | 端口线索 |
|---|---|---|
| Android Studio / AVD / SDK | Win `%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe`、`$env:ANDROID_HOME\emulator\`；mac `~/Library/Android/sdk/emulator/emulator`；Linux `~/Android/Sdk/emulator/emulator` | 5554+2n |
| 雷电 LDPlayer | `<盘>:\LDPlayer\LDPlayer9\dnplayer.exe` | 5555 起 |
| 夜神 Nox | `<盘>:\Program Files\Nox\bin\Nox.exe` | 62001+ |
| MuMu | `<盘>:\Program Files\Netease\MuMu Player 12\shell\MuMuPlayer.exe` | 16384/16416 |
| 逍遥 MEmu | `<盘>:\Microvirt\MEmu\MEmu.exe` | 21503 |

品牌端口只是线索，必须经步骤 4 验证。无盘符且默认路径全 miss 时，才扩展到各盘符根目录（仅 Windows）。

### 步骤 4 — 启动与端口就绪

若模拟器未运行，用找到的可执行文件拉起；最多等 60s。用**端口连通性**判断 adbd 就绪
（`nc -z 127.0.0.1 <port>` / PowerShell `Test-NetConnection`）——**不要依赖宿主机的 `adb` 二进制**，
插件本身也不使用它。

### 步骤 5 — 连通验证（R5）

用本地 Agent 通道逐个候选验证：

```sh
cat "${DSH_HOME:-$HOME/.dsh}/storages/dsh-phone/agent.json"     # 取 token/baseUrl
TOKEN=...; BASE=...
curl -sS -X POST "$BASE/dsh-phone/api/attach/verify" \
  -H 'content-type: application/json' -H "x-dsh-phone-token: $TOKEN" \
  -d '{"endpoint":"127.0.0.1:5555"}'
# -> {"ok":true,"value":{"ok":true,"latencyMs":3,"banner":"..."}}
```

失败就换下一个候选；全部失败才向用户报告已尝试清单，请其补充更具体的一句话。

### 步骤 6 — 写入配置（R1 + R4）

只写两个键（单键调用，各带 revision 可省略；省略时用当前 revision）：

```sh
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["attach","endpoint"],"value":"127.0.0.1:5555"}'
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["attach","resolved"],"value":true}'
```

- 未 verify 的 endpoint：409 `E_NOT_VERIFIED`（R5）；
- 写 `userHint`：403 `E_FORBIDDEN`（R2，一句话只能用户改）；
- 写 endpoint/resolved=true 后，服务端会重新拉起并检查 `phone_status`；未 running 返回 502 `E_DEVICE_DISCONNECTED`（配置可能已落盘，如实向用户报告）。

### 步骤 7 — 汇报

两三句话：品牌/路径、最终 endpoint、连接状态。不要输出探测原始日志。

## 5. Agent 本地通道注意事项

- token 文件：`$DSH_HOME/storages/dsh-phone/agent.json`（0600）。**每次插件重载都会轮换**；长任务中途遇到 401 先重读该文件。
- 只放行三个路由：`POST /attach/verify`、`POST /agent/config`、`GET /status`；且必须 loopback + 无 `Origin` + token 匹配。
- 可写路径（R1 白名单）：`attach.endpoint` / `attach.resolved` / `onboarding.status` / `onboarding.choice`；
  `attach.userHint` 禁止（403 `E_FORBIDDEN`）。
- `verify` 成功记录**只在进程内**：插件重载后需要重新 verify 再写 endpoint（R5）。
- Agent 通道**没有** `GET /config`；读配置用 `dsh --dump-config`。
- token 等价于本机配置写权限：不要打印到公开日志、不要贴进 issue。

## 6. 服务开关与运行时策略

- 插件总开关 `enabled` 只由用户控制（Agent 不得修改）。关闭方式见 [config.md](config.md) §3.4。
- `runtime` 策略同样只由用户决定；**首次使用的 `onboarding.choice` 优先于 `runtime`**（accepted 且非空时等价显式运行时）。
- stream 参数（`maxSize/maxFps/bitrate`）归插件管理，Agent 不调整。

## 7. 资源与性能参考（SPEC §3.7）

| 状态 | CPU | 内存 | 带宽 |
|---|---|---|---|
| stopped | 0 | 0 | 0 |
| running + 无人看 | ~1–3% | ~2GB | 0 |
| running + 人在看 | 单核 30–50%（软编） | ~2GB | 2Mbps |
| paused | ~0 | 保留 | 0 |

- 首次使用提问时就要告知用户「运行中约 2GB 内存」；`cpuPct/memPct` 为**尽力而为**（emulator/redroid/attach 各自采样，取不到则缺省），不要当精确监控。
- 画面卡顿优先建议用户降低 `stream.maxSize/maxFps/bitrate` 或改用硬解浏览器；不要加重负载。

## 8. 已知行为差异（以实现为准）

| SPEC 写法 | 实际实现 |
|---|---|
| 无首次使用守卫 | 新增 `onboarding` 守卫：pending 时任何 `phone_*`（含 `phone_status`）返回 `E_ONBOARDING_REQUIRED`；用户明确同意后才可操作 |
| 右侧栏用 rightbar slot | 注册右侧栏 **tab 类型**（`sidebarRightTabs` + `sidebar.right.pane.tab`），不注册 `rightbar`（会遮蔽官方右栏） |
| 设置页可开关插件 | 设置页只读展示 `enabled`（#52/#39）；开关仍由插件管理/配置文件控制 |
| Agent 用配置 set API 写 endpoint/resolved | 插件提供本地 token 通道 `POST /agent/config`（单键、R1/R4/R5），onboarding 也走同一通道 |
| `phone_status` 返回 cpuPct/memPct | 尽力而为（#56），字段可能缺省 |
| 一句话解析（路径/端口探测）由插件完成 | 由操作 Agent 的 shell 完成；插件只做 verify + 写入 |
