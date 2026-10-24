# 安装、升级与卸载

> 适用于 dsh-phone v0.1.0（发布准备中）。DSH 版本要求：`>=0.2.1-rc.2 <0.3.0`；Node `>=20`。
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

然后**重启 DSH**（客户端 bundle 与 Host 模块都要求新的模块代）。打开「设置 → 手机」应能看到设置页。

- 安装时 `dsh plugin` 会把 dsh-phone 追加进该 profile 的 `dsh.profile.bundles`（因为包声明了 `dsh.bundle.patch`）。
- `--profile` 必须写在转发给 pnpm 的参数**之前**（DSH 0.2.1 规则）。
- 目录安装不需要每次重装：改完源码 `npm run build` 后重启 DSH 即可。
- 不想动正在使用的 profile 时，见第 4 节。

## 2. 从 tarball 安装（发布后）

```sh
npm pack                # -> dsh-phone-0.1.0.tgz（prepack 会执行 build）
dsh plugin --profile web add ./dsh-phone-0.1.0.tgz
```

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

- 客户端 bundle 与 Host 模块都需要**重启**才会换新；页面刷新不够。
- 升级后插件会重新生成 Agent token（旧 token 立即失效）；若改过 `docs/`/配置字段，重新看 [config.md](config.md)。
- tarball 安装：`dsh plugin --profile web add ./dsh-phone-0.1.0.tgz` 覆盖安装即可。

## 6. 卸载

```sh
dsh plugin --profile web remove dsh-phone
rm -f "${DSH_HOME:-$HOME/.dsh}/storages/dsh-phone/agent.json"   # 正常卸载会自动删除；残留时手动清
rm -f /path/to/dsh-phone/assets/scrcpy-server.jar                # 可选
```

- 配置数据（`attach.*`）保留在 profile 的 `cordis.patch.yml` 中；重新安装后可直接命中缓存（R3）。
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

见 [troubleshooting.md](troubleshooting.md) §1–§3：常见原因是没跑 `npm run build`（`lib/` 不存在）、`engines.dsh` 不匹配、插件开关关闭、或没有重启 DSH。
