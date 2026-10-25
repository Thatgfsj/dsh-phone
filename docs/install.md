# 安装、升级与卸载

> 适用于 dsh-phone v0.2.0（已发布）。DSH 版本要求：`>=0.2.1-rc.2 <0.3.0`；Node `>=20`。
> 安装类问题先看 [troubleshooting.md](troubleshooting.md)。

## 0. 前置条件

| 项 | 要求 | 检查 |
|---|---|---|
| DSH | `0.2.1-rc.2`（或同 minor 的 0.2.x） | `dsh --version` |
| Node | `>=20`（本机开发用 24） | `node --version` |
| 凭据/目录 | 可写 `$DSH_HOME`（默认 `~/.dsh`） | `echo ${DSH_HOME:-~/.dsh}` |
| Android 运行时 | 三选一：Docker+binder / SDK Emulator / 可连的 attach 实例 | 见下表 |
| 浏览器 | 支持 WebCodecs 的现代浏览器（Chrome/Edge 最佳） | 面板会显示「硬解/软解」 |

运行时前置：

| 运行时 | 需要 | 快速检查 |
|---|---|---|
| redroid | Linux + Docker + `binder_linux` | `docker info`；`ls -l /dev/binder` |
| emulator | Android SDK Emulator + 虚拟化 | `ls $ANDROID_HOME/emulator/emulator`；Linux `ls -l /dev/kvm` |
| attach | 模拟器/真机已启动且 adb TCP 端口可达 | `nc -z 127.0.0.1 5555`（Windows 用 `Test-NetConnection`） |

> 插件**不安装任何软件**。前置条件不满足时，工具会返回 `E_RUNTIME_UNAVAILABLE` 并附平台安装指引（见 [troubleshooting.md](troubleshooting.md)）。

## 1. 从源码安装（当前推荐）

```sh
git clone https://github.com/Thatgfsj/dsh-phone.git
cd dsh-phone
npm install
npm run check          # 可选：tsc + 单测 + 行数检查
npm run build          # 生成 lib/（Host 逐文件转译 + Client __ModuleLoader__ bundle）
node scripts/fetch-scrcpy-server.mjs   # 下载并校验 assets/scrcpy-server.jar（v3.3.3）
dsh plugin --profile web add .         # 目录安装（link:/abs/path，不复制文件）
```

然后按顺序：

1. **重启 DSH**（Host 行与 bundle 需要新的模块代）；
2. **刷新浏览器页面（F5）**：客户端插件模块只在页面启动时进入 `window.__DSH_BOOT__` 启动图，
   已打开的页面不会热注入新模块（HMR 只对已加载模块推重建帧）。刷新**不会中断会话**——
   会话与手机实例都在 Host 侧，页面重连后继续。

刷新后打开「设置 → 手机」或会话头部的手机图标；首次使用会看到 onboarding 引导卡片。

- 安装时 `dsh plugin` 会把 dsh-phone 追加进该 profile 的 `dsh.profile.bundles`（因为包声明了 `dsh.bundle.patch`）。
- `--profile` 必须写在转发给 pnpm 的参数**之前**（DSH 0.2.1 规则）。
- 目录安装不需要每次重装：改完源码 `npm run build` 后重启 DSH **并刷新页面**即可。
- 不想动正在使用的 profile 时，见第 4 节。

### 1.1 为什么安装/更新/启用后必须刷新页面

DSH 的客户端模块（`lib/client.js`）在**页面启动时**被组合进 `window.__DSH_BOOT__` 的启动图；
插件动态安装/更新/启用后，新的模块行不会自动进入**已经打开**的页面。DSH 的 HMR 只会对
已加载模块推送重建帧，不能向运行中的页面新增模块——所以必须刷新页面（F5）让启动图重算。

典型症状：`phone_*` 工具可用（Host 已加载），但右侧栏/会话头部/设置页没有手机入口——
这不是插件未安装，而是当前页面还是旧的模块图。刷新页面的影响：

- **不中断会话**：Session 记录在 Host 侧持久化，刷新只是重新连接；手机实例也不会重启
  （懒启动/休眠状态机在 Host，实例状态保持不变）。
- 面板/设置页会重新拉取配置；若正在看视频，面板会重新建立 WS 与解码会话（短暂黑屏后恢复）。
- 首次使用（onboarding pending）时，刷新后会自动打开手机面板并显示确认卡片（见 [client.md](client.md) §1.3）。

需要在以下时机刷新：首次安装、升级（`npm run build` 后重启 DSH 再刷新）、在插件管理中启用/重载插件、
修改 `dsh.client` 或客户端 bundle、切换 profile 后重新打开页面。

## 2. 从 tarball 安装（发布后）

```sh
npm pack                # -> dsh-phone-0.2.0.tgz（prepack 会执行 build）
dsh plugin --profile web add ./dsh-phone-0.2.0.tgz
```

安装后同样**重启 DSH 并刷新页面**（原因见 §1.1）。

tarball 只含 `files` 白名单：`lib/`、`locale/`、`cordis.patch.yml`、`icon.svg`、`README.md`、`LICENSE`、`scripts/`。
**不含** `assets/scrcpy-server*.jar`（需按第 7 节自行获取，或用 `DSH_PHONE_SCRCPY_SERVER` 指向）。

## 3. 验证阶梯

```sh
# 1) 层与行（秒级、不启动）
dsh --profile web --dump-config | grep -n '^# =='         # 看层
dsh --profile web --dump-config | grep -n -A 12 'dsh-phone'  # 看行与配置

# 2) Host 半边真加载（不绑端口）
dsh --profile web --patch /tmp/overlay.yml --help
# overlay.yml:
# - insert:
#     - id: dsh-phone
#       name: '/abs/path/to/dsh-phone/lib/index.js'

# 3) 真实页面
# 重启 dsh 后：Agent 工具列表出现 phone_*；设置 → 手机；打开面板看到首帧
```

> `--patch` 会把 dsh-phone 再插一行，仅用于冒烟验证，验证完删除 overlay；不要把它写进长期配置。

真实页面验收清单：

1. 「设置 → 手机」出现，能读写「一句话」；
2. 面板能从设置页打开，状态栏显示「已连接 / 硬解或软解」；
3. Agent 工具列表出现 9 个 `phone_*`；
4. `phone_status` 返回 `state`（首次可能是 `booting`，等待后重试）。

## 4. 临时 profile 验证（不影响现有配置）

```sh
dsh plugin --profile phone-verify add /abs/path/to/dsh-phone
dsh --profile phone-verify --dump-config | grep -n -A 12 'dsh-phone'
dsh --profile phone-verify --help            # Host 冒烟（不绑端口）
dsh plugin --profile phone-verify remove dsh-phone
rm -rf "$HOME/.dsh/profiles/phone-verify"    # 用完即删
```

注意：`dsh plugin` 自动初始化的临时 profile 只含 `dsh-base` 层，**没有 Web 前端**，所以适合验证 Host 加载与配置，不适合验证右侧栏 UI。UI 验证请用你实际启动的 web profile（或按 DSH 文档给临时 profile 加 web 层）。

## 5. 升级

目录安装（`link:`）：

```sh
cd /path/to/dsh-phone
git pull
npm install
npm run build
# 重启 DSH；无需重新 dsh plugin add
```

- Host 模块与客户端 bundle 都需要**重启 DSH** 才会换新；重启后还要**刷新已打开的页面**（客户端模块在页面启动时入图；只重启不刷新旧页面仍看不到新 UI）。
- 升级后插件会重新生成 Agent token（旧 token 立即失效）；若改过 `docs/`/配置字段，重新看 [config.md](config.md)。
- tarball 安装：`dsh plugin --profile web add ./dsh-phone-0.2.0.tgz` 覆盖安装即可。

## 6. 卸载

```sh
dsh plugin --profile web remove dsh-phone
rm -f "${DSH_HOME:-$HOME/.dsh}/storages/dsh-phone/agent.json"   # 正常卸载会自动删除；残留时手动清
rm -f /path/to/dsh-phone/assets/scrcpy-server.jar                # 可选
```

- 配置数据（`attach.*`）保留在 profile 的 `cordis.patch.yml` 中；重新安装后可直接命中缓存（R3）。
- **卸载后刷新页面**：Host 已移除，但旧页面仍持有旧客户端模块，刷新前右侧栏/设置页入口不会消失。
- 删除 profile 目录前确认绝对路径；不要删正在使用的 `web` profile。

## 7. scrcpy-server jar（必需）

视频流与控制通道（含中文 `phone_input_text`）依赖与 `@yume-chan/scrcpy` 3.3.3 匹配的 scrcpy-server：

```sh
node scripts/fetch-scrcpy-server.mjs            # 官方 GitHub Release -> assets/scrcpy-server.jar
node scripts/fetch-scrcpy-server.mjs --check    # 只校验本地文件，不联网
node scripts/fetch-scrcpy-server.mjs --force    # 忽略缓存重新下载
node scripts/fetch-scrcpy-server.mjs --mirror https://ghproxy.net/   # 追加镜像前缀
```

- 版本 **v3.3.3**；sha256 `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`（90164 bytes）。校验不一致不会替换文件。
- 上游许可 **Apache-2.0**（Genymobile/scrcpy）；jar **不提交仓库、不随 npm 包分发**。
- 运行时可用环境变量 `DSH_PHONE_SCRCPY_SERVER=/abs/path/scrcpy-server.jar` 覆盖默认路径（默认 `<包目录>/assets/scrcpy-server.jar`）。
- 离线：在另一台联网机器下载官方 asset，校验 sha256 后放到 `assets/scrcpy-server.jar`。
- 镜像（`ghproxy.net` / `ghfast.top`）只是回退，可用性未逐个验证；官方 URL 已实测通过校验。

## 8. 安装失败排查

见 [troubleshooting.md](troubleshooting.md) §1–§3：常见原因是没跑 `npm run build`（`lib/` 不存在）、`engines.dsh` 不匹配、插件开关关闭、或没有重启 DSH / 刷新页面。
