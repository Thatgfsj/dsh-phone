# 使用指南

> 面向两类读者：**操作 Agent**（按 [skill/dsh-phone/SKILL.md](../skill/dsh-phone/SKILL.md) 的 SOP 工作）
> 与**人类用户**（在设置页填一句话、在右侧栏看手机）。
> 需求原文见 [SPEC.md](SPEC.md) §4–§5；实现细节见 [host.md](host.md)、[stream.md](stream.md)、[client.md](client.md)。

## 1. 打开面板与设置页

1. 重启 DSH 后，打开「设置 → 手机」：
   - 「一句话」：描述你的模拟器/真机在哪里（原文永久保留）；
   - 「解析状态」：显示 `attach.resolved` 与当前 `attach.endpoint`；
   - 「打开手机面板」：打开右侧栏的「手机」tab；
   - 「重置解析」：把 `attach.resolved` 置回 `false`（需用户确认；Agent 不会调用）。
2. 面板开启后：左侧是实时画面（WebCodecs 硬解，失败回退 TinyH264 软解），底部有 HOME/BACK/RECENTS/ENTER/DEL 按键，状态栏显示连接与解码状态。
3. **不可见即停流**：切走 tab、折叠右栏或页面不可见时，客户端立即断流；Host 在最后一个 viewer 离开 5s 后停止 scrcpy 会话（实例继续 running）。

## 2. 日常操作 SOP（对应 SPEC §5.1）

```
1. phone_status
   ├─ running → 进入操作循环
   ├─ booting → 等待后重试（工具已返回 E_BOOTING + bootMs，不要中断任务）
   ├─ paused  → 任意 phone_* 调用会自动唤醒（redroid 亚秒 / emulator 3–6s / attach 重连）
   └─ stopped → 任意 phone_* 调用触发懒启动；若 runtime=attach 且 resolved=false → 转 §3 接入流程
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

## 3. 首次接入流程（SPEC §5.2 的实现版）

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

## 4. Agent 本地通道注意事项

- token 文件：`$DSH_HOME/storages/dsh-phone/agent.json`（0600）。**每次插件重载都会轮换**；长任务中途遇到 401 先重读该文件。
- 只放行三个路由：`POST /attach/verify`、`POST /agent/config`、`GET /status`；且必须 loopback + 无 `Origin` + token 匹配。
- `verify` 成功记录**只在进程内**：插件重载后需要重新 verify 再写 endpoint（R5）。
- Agent 通道**没有** `GET /config`；读配置用 `dsh --dump-config`。
- token 等价于本机配置写权限：不要打印到公开日志、不要贴进 issue。

## 5. 服务开关与运行时策略

- 插件总开关 `enabled` 只由用户控制（Agent 不得修改）。关闭方式见 [config.md](config.md) §3.4。
- `runtime` 策略同样只由用户决定；Agent 只能在用户明确要求时协助修改，不得"顺手优化"。
- stream 参数（`maxSize/maxFps/bitrate`）归插件管理，Agent 不调整。

## 6. 资源与性能参考（SPEC §3.7）

| 状态 | CPU | 内存 | 带宽 |
|---|---|---|---|
| stopped | 0 | 0 | 0 |
| running + 无人看 | ~1–3% | ~2GB | 0 |
| running + 人在看 | 单核 30–50%（软编） | ~2GB | 2Mbps |
| paused | ~0 | 保留 | 0 |

- `cpuPct/memPct` **当前未实现**，`phone_status` 不返回这两个值；不要据此判断负载。
- 画面卡顿优先建议用户降低 `stream.maxSize/maxFps/bitrate` 或改用硬解浏览器；不要加重负载。

## 7. 已知行为差异（以实现为准）

| SPEC 写法 | 实际实现 |
|---|---|
| 右侧栏用 rightbar slot | 注册右侧栏 **tab 类型**（`sidebarRightTabs` + `sidebar.right.pane.tab`），不注册 `rightbar`（会遮蔽官方右栏） |
| 设置页可开关插件 | 设置页表单只含 volatile 三键；`enabled` 由插件管理/配置文件控制 |
| Agent 用配置 set API 写 endpoint/resolved | 插件提供本地 token 通道 `POST /agent/config`（单键、R1/R4/R5） |
| `phone_status` 返回 cpuPct/memPct | 未实现，字段缺省 |
| 一句话解析（路径/端口探测）由插件完成 | 由操作 Agent 的 shell 完成；插件只做 verify + 写入 |
