# 验收矩阵与安装冒烟（#8）

> 本文记录**可重复执行**的验收矩阵、本机实际结果、环境约束与未覆盖项。
> 一条命令：\`npm run verify\`（内部串行执行 5 组检查，任一失败整体退出码非 0）。
> 真实设备链路另由 env-gated 脚本 scripts/verify/verify-emulator.mjs 覆盖（DSH_PHONE_E2E=1 才跑；默认 SKIP 不碰设备）。
> 未测项一律显式 SKIP 并写明原因，**不允许假绿**；"人工待办"不是已通过。
>
> **v0.2.0（2026-10-25）发布状态**：#40 真实环境验收仍在进行中（#58 未合并）——本文件 §2 的 SKIP 项
> 与 §5 的人工待办仍然有效，**不代表已通过**；#56 的 cpu/mem 采样与 booting `phase` 只做了单测/假环境验证。
> 待 #40/#58 完成后更新本矩阵。

## 1. 一条命令跑什么

\`\`\`
npm run verify
├── scripts/verify/verify-tools.mjs      假 ctx 加载 apply：9 个 phone_* 工具 / 参数 / phone_shell ask
├── scripts/verify/verify-stream.mjs     createStreamUpgradeRoute + 假 socket：握手 / DPH1 / 5s 宽限 / 断开清理
├── scripts/verify/verify-install.mjs    临时 profile 安装冒烟（dump-config / dump-config-schema / --help / 隔离 web apply）
├── scripts/verify/verify-emulator.mjs   真实 emulator attach 链路（DSH_PHONE_E2E=1 才跑；默认 SKIP）
├── scripts/check-file-lines.mjs         单文件 ≤1000 行硬线
└── node --test tests/e2e/*.test.mjs     无真机/容器/浏览器场景显式 SKIP（带原因）
\`\`\`

实现约束：

- 每个脚本可单独运行（\`node scripts/verify/verify-install.mjs\` 等），失败退出码非 0；
- \`verify-install\` 在干净 checkout 首次运行、\`node_modules/\` 缺失时自动 \`npm install --no-audit --no-fund\`，随后总是 \`npm run build\`（\`lib/\` 不入库，必须先构建）；
- 临时 profile 名固定为 \`phone-verify\`（\`$DSH_HOME/profiles/phone-verify\`，默认 \`~/.dsh\`），**不触碰 \`web\` / \`headless\` profile**；进程被 SIGINT/SIGTERM 打断时也会执行清理；
- 阶段 B 使用 \`mkdtemp\` 隔离的临时 \`DSH_HOME\` 启动 web（\`--no-open --port 0\`），不会占用/复用用户 3080 实例；结束删除临时 home 与进程；
- 所有清理经 LIFO \`Cleanup\` 登记，失败只告警不掩盖主失败。

## 2. 本机验收结果（2026-10-25，feat/8-verify）

环境：Debian 13 / Node v24.21.0 / npm 11.19.0 / pnpm 12.11.2 / dsh 0.2.1-rc.2（全局安装）。

| # | 验收项 | 命令 | 本机结果 | 环境约束 | 未覆盖 / 备注 |
|---|---|---|---|---|---|
| 1 | 类型检查 | \`npm run typecheck\` | PASS | 无 | — |
| 2 | 单元测试（runtime/adb/host/tools/stream/client） | \`npm test\` | PASS | 无 | 不依赖真机；本次 verify 不重复跑，入口见 \`npm run check\` |
| 3 | 单文件 ≤1000 行 | \`node scripts/check-file-lines.mjs\` | PASS（102 个文件） | 无 | 目标 ≤300 行/文件由 review 把关 |
| 4 | 构建 | \`npm run build\` | PASS（host=48 file(s), client=bundled） | 需要 \`node_modules\` | \`lib/\` 不提交 |
| 5 | 工具注册（apply） | \`node scripts/verify/verify-tools.mjs\` | PASS | 无 | 9 个工具名/顺序/参数/描述、phone_shell ask/白名单、enabled=false |
| 6 | WS 协议 | \`node scripts/verify/verify-stream.mjs\` | PASS | 假 socket | 101 握手、DPH1、visibility 5s 宽限、断开清理、鉴权 403 |
| 7 | 安装冒烟（profile + dump） | \`node scripts/verify/verify-install.mjs\` | PASS | 本机 dsh + pnpm | 见 §3 证据 |
| 8 | 安装冒烟（web apply） | 同上（阶段 B） | PASS | 临时隔离 \`DSH_HOME\` | 起 web 进程，验证 401/200 与 config 生效 |
| 9 | redroid 真实运行时 | e2e | SKIP | 需 Docker + binder | 本机无 Docker |
| 10 | emulator 真实运行时（attach 复用现有实例） | DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs | **PASS**（截图 + Host WS ready/DPH1 + 控制 + 释放） | 需 127.0.0.1:5555 有 adbd；本机实例由用户 live 会话拉起 | 见 §7；#59/#60 修复后重跑通过 |
| 11 | scrcpy 实连（stream 层直连对照） | 同上（脚本内直连 src/stream） | PASS（704ms push/start；51 帧/5s，keyframe 1，control OK） | 真实 emulator | Host WS 路径同样 PASS（102 帧/10s）；见 §7 |
| 12 | emulator 自启（B 分支） | — | SKIP | 需停用用户 live 实例 | 按 Lead 决策不 SIGTERM 用户实例；由 #40 人工清单覆盖 |
| 13 | 真实 attach（TCP adbd） | 同上 | PASS（ADB 直连 + getprop + wm size） | 127.0.0.1:5555 | 本机为 emulator adbd，非独立真机 |
| 14 | 真实浏览器页面 | 人工 | 人工待办 | 需浏览器/自动化 | 见 §5，不冒充通过 |

\`npm run verify\` 汇总输出（实跑）：

\`\`\`
  PASS 工具注册与 phone_shell 审批（verify-tools）
  PASS WS 协议 / DPH1 / 5s 宽限（verify-stream）
  PASS 临时 profile 安装冒烟（verify-install）
  PASS 单文件行数（≤1000 硬线）
  PASS e2e 矩阵（无真机/容器/浏览器，全部带 skip 原因）
验收通过：5/5 项（skip 项见上方 e2e 输出与 docs/verification.md）
\`\`\`

e2e 输出 5 个用例全部 SKIP，skip 原因逐条打印（原文）：

\`\`\`
﹣ 真实运行时：redroid（Docker + binder） # 本机无 Docker（docker version 失败）…
﹣ 真实运行时：Android emulator（AVD headless） # 本机无 Android SDK emulator 包 / AVD…
﹣ 真实链路：scrcpy pushServer + 视频/控制 socket # 本机无 scrcpy-server jar，且无真机/可用 attach 端点
﹣ 真实浏览器：右栏面板 / WebCodecs(Annex-B) / TinyH264 回退 / 设置页 # 本机无浏览器自动化依赖…
﹣ 真实 attach：TCP adbd 连接 + getprop + screencap # 未设置 DSH_PHONE_E2E_ENDPOINT…
ℹ tests 5 / pass 0 / fail 0 / skipped 5
\`\`\`

## 3. 安装冒烟关键证据（verify-install 实跑）

### 3.1 dump-config（是否看到 dsh-phone 行）

安装（\`--from-default-profile headless\` 初始化 + \`dsh plugin --profile phone-verify add .\`）后：

\`\`\`
- id: dsh-phone
  name: dsh-phone
\`\`\`

再向**临时 profile** 的 \`cordis.patch.yml\` 写入用户层（仅测试用）后，组合结果包含：

\`\`\`
runtime: attach
maxSize: 640
userHint: 验证用一句话
\`\`\`

即 dump-config 既能看到插件行，也能看到 profile 用户层 config 生效。

### 3.2 dump-config-schema

- \`x-cordis.complete = true\`，无 error 诊断；
- dsh-phone entry 的 config schema 顶层字段：\`enabled/runtime/attach/redroid/emulator/stream/lifecycle/limits\`；
- \`attach.endpoint|userHint|resolved\` 均带 \`x-cordis.volatile: true\`；
- \`stream\` 默认 720/15/2000000，\`lifecycle\` 默认 300000/1800000，\`limits.maxInstances=1\`，runtime 四枚举齐全。

### 3.3 --help（apply 真执行）

\`dsh --profile phone-verify --help\` 退出码 0，stdout 为 headless app 的 usage（说明 profile 成功启动、插件行已 apply）；
stderr 仅有宿主无关警告（本机 \`all_proxy\` 是 SOCKS 的提示），**无 dsh-phone 插件加载错误**。
（\`--help\` 本身不打印工具列表，故另用 §3.4 的隔离 web 启动证明 apply 的副作用。）

### 3.4 隔离 DSH_HOME 的 web apply 冒烟

- 在临时 \`DSH_HOME\` 复制 web 模板 + 安装 dsh-phone + 写用户层，\`dsh --profile phone-verify --no-open --port 0\` 启动；
- 捕获启动 URL 后：
  - \`storages/dsh-phone/agent.json\` 存在，\`baseUrl\` 等于实际监听 origin，token 为 64 位 hex，权限 0600；
  - 未认证 \`GET /dsh-phone/api/config\` → **401** \`E_AUTH\`（路由已注册且有鉴权）；
  - 携带启动 URL 的浏览器 token 换取同源 cookie 后 → **200**，\`{runtime:"attach", stream:{maxSize:640,...}}\`（profile 用户层 config 真实生效）；
- 结束 SIGTERM，web 进程退出码 0，临时 home 与 profile 全部删除。
- **观察项**：本机 SIGTERM 后 \`agent.json\` 仍残留（异步 dispose 未被等待）。文件位于隔离临时 home，随 home 删除，不影响用户；"卸载后 token 文件删除"仍属未验证项（见 §4）。

## 4. 未覆盖项（不得视为通过）

1. **真实运行时**：redroid 未验证（无 Docker）；emulator 自启（B 分支）未验证（需停用用户 live 实例）；本机 attach 复用已有 emulator 已实测（§7）。
2. **Host WS 视频流**：真实设备上已实测 PASS（#59/#60 修复后：ready + DPH1，102 帧/10s、控制无 error）；修复前的 FAILED 记录见 §7.1。
3. **phone_shell 审批 UI 往返**：waterfall 返回 ask 的逻辑已验；真实审批 UI 点击「允许一次/拒绝」未跑。
4. **配置 volatile 热更新**：\`ctx.settings.mutate\` 真实写入 + 插件读到新值 + 配置行不重载，未在真实 dsh Web 会话验证（安装冒烟只验证了启动时 profile 用户层 config 生效）。
5. **Agent token 通道**：\`agent.json\` 落盘/0600/loopback+无 Origin 判定已在真实进程验证 token 通道的"未认证 401"分支；但带 \`x-dsh-phone-token\` 的 \`POST /attach/verify\`、\`POST /agent/config\`、\`GET /status\` 未在真实设备/真实写配置场景跑通。
6. **attachments 图片内容块**：\`saveImage\` 失败降级有单测；真实模型路由是否接受 image block 未验证。
7. **\`ctx.connection.requestRejection\` 在自定义 prefix/upgrade 的真实行为**：安装冒烟验证了返回 401 的路径；401/403 的 Origin/跨站语义未在真实浏览器验证。
8. **卸载/重载清理**：token 文件删除见 §3.4 观察项；HMR 重载后的旧 token 失效未验证。
9. **本地平台限制**：本机无 Docker、无独立真机、无浏览器自动化；emulator + AVD + scrcpy jar 已具备（§7 实测）。
10. **真实缺陷（本轮发现，已由 #59/#60 修复并复测）**：Host PhoneService 曾把 AdbConnection.raw 传给 stream 层导致真实设备 E_STREAM_START_FAILED；修复后重跑 §7 全链路 PASS，缺陷记录保留在 §7.1 供追溯。

## 5. 人工待办（真实浏览器，禁止当成已通过）

来自 \`docs/client.md §6\`、\`docs/host.md §7\`、\`docs/stream.md §8\`，需在真实 Chrome/Firefox/Safari + 可用 Android 实例上人工执行：

- [ ] 右侧栏面板能打开、标题/主题 token、明暗切换、画布尺寸/DPR 正确；
- [ ] WebCodecs 接受 \`avc.format='annexb'\` + in-band SPS/PPS 并稳定解码 720p/15fps；
- [ ] TinyH264 主线程软解回退路径可播放，CPU/帧率可接受；
- [ ] 面板不可见（tab 切换/折叠/页面隐藏）时 \`IntersectionObserver + visibilitychange\` 双检测触发断流，恢复可见自动重连；
- [ ] 设置页写入 \`attach.userHint\`（同源 cookie，含 409 重试一次）真实落盘并回读；
- [ ] 软解回退发生在流中途时，等待下一个关键帧的实际时延；
- [ ] \`phone_shell\` 审批 UI：非白名单命令弹「允许一次/拒绝」，白名单不弹；
- [ ] 真实实例上 \`phone_screenshot\` 的 image block 被模型路由接受、截图内容正确；
- [ ] 真实实例上 tap/swipe/key/input_text（中文 INJECT_TEXT）/app_launch/uiautomator_dump 的视觉+控件树闭环；
- [ ] 真实 redroid / emulator / attach 三运行时启动、懒启动、booting 中间态、休眠与恢复；
- [ ] scrcpy 实连：pushServer、首帧、控制通道、断开重连；
- [ ] 真实 dsh 会话中 \`ctx.settings.mutate\` volatile 热更新与配置行不重载。

## 6. 复现方式

\`\`\`sh
# 仓库根目录（干净 checkout 亦可；node_modules 缺失时 verify 会自动 npm install）
npm install          # 可选：verify 会检测缺失后自动安装
npm run verify       # 一条命令：工具/协议/安装冒烟/行数/e2e(skip)
\`\`\`

带真实 attach 设备时额外启用：

\`\`\`sh
DSH_PHONE_E2E=1 npm run verify                 # 含 verify-emulator + real-emulator e2e
DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs
DSH_PHONE_E2E_ENDPOINT=127.0.0.1:5555 npm run verify   # 独立真机 attach e2e
\`\`\`

单独运行某一项：

\`\`\`sh
node scripts/verify/verify-tools.mjs
node scripts/verify/verify-stream.mjs
node scripts/verify/verify-install.mjs
node --test tests/e2e/*.test.mjs
\`\`\`

清理核对（verify 正常/异常退出后均应成立）：

\`\`\`sh
test ! -e ~/.dsh/profiles/phone-verify && echo "临时 profile 已清理"
ls /tmp | grep -c '^dsh-phone-verify-' || true   # 应为 0（隔离临时 home）
\`\`\`


## 7. 真实 emulator attach 链路实测（#40，2026-10-25）

环境：Debian 13 / Node v24.21.0 / dsh 0.2.1-rc.2；emulator-5554（sdk_gphone64_x86_64，
Physical size: 720x1280）由**用户 live dsh web（3080）会话中的插件拉起**，本验收只复用、
**未启动也未停止**该实例（清理后端口仍可达）。隔离临时 DSH_HOME + 临时 phone-e2e web
profile（--no-open --port 0），onboarding 写 status=accepted / choice=attach +
attach.endpoint=127.0.0.1:5555。

复测：origin/main 29bc9b9（#59/#60 修复）合入后，2026-10-25 15:15 重跑，结果如下（修复前的失败记录见 §7.1）。

命令：DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs（约 34s；退出码 0）

| 检查项 | 结果 | 实测证据 |
|---|---|---|
| 临时 web apply + 同源鉴权 | PASS | /config 返回 enabled=true, runtime=attach, onboarding={accepted,attach}, attach.endpoint=127.0.0.1:5555, resolved=true |
| GET /screenshot -> PNG | **PASS** | 720x1280，708213 bytes，attempts=1，775ms，保存 /tmp/dsh-phone-e2e/screenshot-*.png |
| WS 握手 + hello | PASS | 带同源 Cookie 的 Upgrade 成功（101），hello 后收 state/ready |
| Host WS 视频流 ready/DPH1 | **PASS** | ready: codec=h264, 720x1280, deviceWidth/Height=720/1280, maxSize=720, maxFps=15；10s 收 **102 帧**（config=1, key=1, delta=100，约 10.2fps），DPH1 头全部合法 |
| stream 层直连对照 | **PASS** | startStream 704ms（含 pushServer），5s 收 51 帧（~10fps）、keyframe 1、video 408x720、deviceWidth/Height=720/1280；injectKey/touch/text 全成功 |
| Host 释放/状态 | **PASS** | WS 关闭 + 6.5s 后 GET /status 仍 running；二次 WS 连接重建成功并收到 31 帧（viewer 已释放） |
| 清理 | PASS | 临时 web 退出码 0、隔离 home/profile 删除；emulator 仍可达=true（未停止用户实例） |
| emulator 自启（B 分支） | SKIP | 5554/5555 被用户 live 实例占用；按 Lead 决策不 SIGTERM 用户实例，需停用后再由人工清单覆盖 |
| 真实浏览器渲染/WebCodecs/TinyH264 | 人工待办 | 见 §5，不冒充通过 |

### 7.1 缺陷记录：host-adb-raw-double-unwrap（已修复）

- 现象：真实设备上右侧栏 WS 视频流启动失败，E_STREAM_START_FAILED: Cannot read properties of undefined (reading sync)。
- 定位：Host 接线把 AdbConnection.raw（已是 Tango Adb 实例）传给 stream 层
  （src/phone/service.ts:331 视频会话、:534 control-only），而 stream 层
  src/stream/scrcpy.ts 期望 AdbConnection 并再次读 adb.raw -> undefined，
  AdbScrcpyClient.pushServer(undefined) 读 .sync 抛错。
- 影响：视频流（WS）与 phone_input_text/触摸控制通道在真实设备不可用；截图/工具 shell 不受影响。
- 处理：本 PR 不修；已记录 issue #59，由 #59/#60 修复（service.ts 传 AdbConnection 而非 .raw），合并后本脚本重跑 **全链路 PASS**（见上表），缺陷保留记录供追溯。

### 7.2 复现与证据

    DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs
    cat /tmp/dsh-phone-e2e/report.json        # 机器可读报告（含缺陷分类/帧数/耗时）
    ls /tmp/dsh-phone-e2e/screenshot-*.png    # 截图证据

证据文件：/tmp/dsh-phone-e2e/report.json（本轮实测）、截图 PNG；临时 web/DSH_HOME 已清理。
