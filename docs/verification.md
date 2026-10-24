# 验收矩阵与安装冒烟（#8）

> 本文记录**可重复执行**的验收矩阵、本机实际结果、环境约束与未覆盖项。
> 一条命令：\`npm run verify\`（内部串行执行 5 组检查，任一失败整体退出码非 0）。
> 未测项一律显式 SKIP 并写明原因，**不允许假绿**；"人工待办"不是已通过。

## 1. 一条命令跑什么

\`\`\`
npm run verify
├── scripts/verify/verify-tools.mjs      假 ctx 加载 apply：9 个 phone_* 工具 / 参数 / phone_shell ask
├── scripts/verify/verify-stream.mjs     createStreamUpgradeRoute + 假 socket：握手 / DPH1 / 5s 宽限 / 断开清理
├── scripts/verify/verify-install.mjs    临时 profile 安装冒烟（dump-config / dump-config-schema / --help / 隔离 web apply）
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
| 10 | emulator 真实运行时 | e2e | SKIP | 需 SDK emulator + AVD | 本机无 emulator 包/AVD |
| 11 | scrcpy 实连 | e2e | SKIP | 需真机/attach + scrcpy-server jar | 本机均无 |
| 12 | 真实 attach（TCP adbd） | e2e | SKIP | 需 \`DSH_PHONE_E2E_ENDPOINT\` | 本机无真机；waydroid adb 端口不可达 |
| 13 | 真实浏览器页面 | 人工 | 人工待办 | 需浏览器/自动化 | 见 §5，不冒充通过 |

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

1. **真实运行时**：redroid / emulator / 真机 attach 均未端到端启动；runtime detect 决策树与适配器只有单测 + 假 adb。
2. **scrcpy 实连**：pushServer、video/control socket、\`wm size\` 真机分辨率、720p/15fps/2Mbps 实际带宽与背压未验证。
3. **phone_shell 审批 UI 往返**：waterfall 返回 ask 的逻辑已验；真实审批 UI 点击「允许一次/拒绝」未跑。
4. **配置 volatile 热更新**：\`ctx.settings.mutate\` 真实写入 + 插件读到新值 + 配置行不重载，未在真实 dsh Web 会话验证（安装冒烟只验证了启动时 profile 用户层 config 生效）。
5. **Agent token 通道**：\`agent.json\` 落盘/0600/loopback+无 Origin 判定已在真实进程验证 token 通道的"未认证 401"分支；但带 \`x-dsh-phone-token\` 的 \`POST /attach/verify\`、\`POST /agent/config\`、\`GET /status\` 未在真实设备/真实写配置场景跑通。
6. **attachments 图片内容块**：\`saveImage\` 失败降级有单测；真实模型路由是否接受 image block 未验证。
7. **\`ctx.connection.requestRejection\` 在自定义 prefix/upgrade 的真实行为**：安装冒烟验证了返回 401 的路径；401/403 的 Origin/跨站语义未在真实浏览器验证。
8. **卸载/重载清理**：token 文件删除见 §3.4 观察项；HMR 重载后的旧 token 失效未验证。
9. **本地平台限制**：本机无 Docker、无 emulator 包/AVD、无 scrcpy 二进制、无真机、无浏览器自动化；\`waydroid\` adb 端口不可达。

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
DSH_PHONE_E2E_ENDPOINT=127.0.0.1:5555 npm run verify
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
