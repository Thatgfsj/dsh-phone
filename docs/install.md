# 安装、升级与卸载

> 适用于 dsh-phone **v0.2.1**（以 [Releases](https://github.com/Thatgfsj/dsh-phone/releases) 最新 tag 为准）。
> DSH 版本要求：`>=0.2.1-rc.2 <0.3.0`；Node `>=20`。安装类问题先看 [troubleshooting.md](troubleshooting.md) §1/§1.1。

## 0. 前置条件

| 项 | 要求 | 检查 |
|---|---|---|
| DSH | `0.2.1-rc.2`（或同 minor 的 0.2.x） | `dsh --version` |
| Node | `>=20`（本机开发用 24） | `node --version` |
| 凭据/目录 | 可写 `$DSH_HOME`（默认 `~/.dsh`） | `echo ${DSH_HOME:-~/.dsh}` |
| Android 运行时 | 三选一：Docker+binder / SDK Emulator / **可连的 attach 实例** | 见下表 |
| 浏览器 | 支持 WebCodecs 的现代浏览器（Chrome/Edge 最佳） | 面板会显示「硬解/软解」 |

运行时前置：

| 运行时 | 需要 | 快速检查 |
|---|---|---|
| redroid | Linux + Docker + `binder_linux` | `docker info`；`ls -l /dev/binder` |
| emulator | Android SDK Emulator + 虚拟化 | `ls $ANDROID_HOME/emulator/emulator`；Linux `ls -l /dev/kvm` |
| attach | 模拟器/真机已启动且 adb TCP 端口可达 | `nc -z 127.0.0.1 5555`（Windows 用 `Test-NetConnection`） |

> 插件**不安装任何软件**。前置条件不满足时，工具会返回 `E_RUNTIME_UNAVAILABLE` 并附平台安装指引。
> **若已经有一台运行中的 emulator/真机，优先 attach 复用（§1.4），不要再让插件起第二台。**

## 1. 推荐：GitHub Release 预构建 tgz（无需 `npm run build`）

发布流水线（构建期 CI，#74 起）会产出预构建包，内含 `lib/`（Host 转译产物 + 客户端 bundle）、
`locale/`、`cordis.patch.yml`、`icon.svg`、`README.md`、`LICENSE`、`scripts/`。

### 1.1 下载并安装

1. 打开 <https://github.com/Thatgfsj/dsh-phone/releases>，选最新 tag（如 `v0.2.1`），
   在 **Assets** 下载 `dsh-phone-<version>.tgz`；或用 gh CLI：

   ```sh
   gh release download v0.2.1 -R Thatgfsj/dsh-phone -p 'dsh-phone-*.tgz'
   tar -tzf dsh-phone-0.2.1.tgz | head -20     # 确认包内直接有 lib/、locale/、cordis.patch.yml
   ```

2. 安装到目标 profile（`--profile` 必须写在转发参数之前）：

   ```sh
   dsh plugin --profile web add ./dsh-phone-0.2.1.tgz
   ```

3. **重启 DSH**，然后**刷新浏览器页面（F5）**（区别见 §1.3）。

> 若最新 Release 的 Assets 暂时没有 tgz：说明发布流水线尚未上传，可从最新一次
> Actions `build` 运行的 artifact `dsh-phone`（zip 内有 tgz）下载，或按 §2 本地源码安装。
> **不要**执行 `dsh plugin add dsh-phone`：npm registry 上的 `dsh-phone` 是另一个项目
> （PonyDevAI/dsh-phone），本仓库未发布 npm registry。

### 1.2 安装后校验（必需）与「半安装」修复

安装/升级后先验证 profile 真的选用了 bundle：

```sh
dsh --profile web --dump-config | grep -n -A 8 'dsh-phone'
# 期望看到 - id: dsh-phone / name: dsh-phone 的行
```

**没有该行 = 半安装**：依赖已装进 profile，但 bundle 没进 `dsh.profile.bundles`，因此
`--dump-config` 无行、`/dsh-phone/api/*` 404、工具不出现。重跑 `dsh plugin add` 不保证修复
（#74 实测）。按顺序处理：

1. 打开 DSH 的 **Plugins（插件管理）页**，找到 `dsh-phone` 并启用/重载；或
2. 手工把 `dsh-phone` 加进 profile 的 bundle 列表：

   ```sh
   PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web/package.json"
   node -e "const p=require(process.argv[1]); console.log('dependency:', p.dependencies?.['dsh-phone']); console.log('bundles:', p.dsh?.profile?.bundles)" "$PROFILE"
   ```

   缺 `dsh-phone` 时，在 `dsh.profile.bundles` 数组里加入 `"dsh-phone"`（保留其余 bundle 顺序），保存后**重启 DSH**。
3. 仍无行：检查 `<profile>/node_modules/dsh-phone/lib/index.js` 与 `lib/client.js` 是否存在
   （不存在 → 装到的是没有构建产物的源码包，见 §2/§8）；重新安装 Release tgz。

四项快速对齐（任一不满足都算未装好）：

| 检查 | 命令/位置 | 期望 |
|---|---|---|
| dependency | profile `package.json` 的 `dependencies['dsh-phone']` | 存在（tgz/link 路径） |
| bundle 选中 | `dsh.profile.bundles` 含 `dsh-phone` | 存在 |
| 行与配置 | `dsh --profile web --dump-config` | 有 `id: dsh-phone` 行 |
| Host/API | 重启后 `curl -i http://127.0.0.1:<port>/dsh-phone/api/config`；或 `install-check`（带 Agent token，期望 200） | 401（已加载需认证）或 200；**404 = 行未加载** |

> 仓库内提供 `scripts/install-check.mjs`（#74 安装自检），按上表四项逐条校验并给出修复建议：
>
> ```sh
> node scripts/install-check.mjs --profile web        # 人读输出
> node scripts/install-check.mjs --profile web --json # CI 机器可读
> ```
>
> 它只读、不重启 DSH；`api` 检查自动读 `$DSH_HOME/storages/dsh-phone/agent.json` 的 `baseUrl`/token（也可 `--base-url/--token`），DSH 未运行时记为 `SKIP`。

### 1.3 重启 DSH 与刷新页面（F5）的区别（都需要）

| 动作 | 作用域 | 何时必须 |
|---|---|---|
| **重启 DSH** | 重新加载 Host 模块与 profile 的 bundle 层；新的插件行/配置生效 | 首次安装、升级、修改 `dsh.profile.bundles`、改 `enabled`、安装后仍无 API/工具 |
| **刷新页面（F5）** | 重算 `window.__DSH_BOOT__` 客户端模块图，加载新的 `lib/client.js` | 安装/更新/启用后 UI 不出现；刷新**不中断会话与手机实例** |

- 只重启不刷新：Host 工具/API 已就绪，但旧页面仍没有设置页/面板入口（客户端模块在页面启动时入图）。
- 只刷新不重启：旧页面拿到新客户端，但 Host 没有新行——工具/API 仍缺失（404）。
- 动态安装/更新/启用后**先重启、再 F5**；面板/设置页会重新拉取配置并重连。

### 1.4 复用已运行的 emulator（优先 attach，不要再起一台）

若已经有一台 emulator/真机在运行，**不要选 emulator runtime**（它会按 AVD 再起一个实例，
端口往后顺延，浪费内存/CPU）。正确做法：

1. 确认 adb TCP 端口可达（多数 AVD 为 `127.0.0.1:5555`，第二台起从 `5554/5555` 之上顺延）：

   ```sh
   nc -z 127.0.0.1 5555        # Windows: Test-NetConnection 127.0.0.1 -Port 5555
   ```

2. 首次使用引导里选「连接已有模拟器/真机（attach）」，或在设置页/Agent 通道写入
   `attach.endpoint=127.0.0.1:5555` 并 `attach.resolved=true`（Agent 先 `/attach/verify`，R5）。
3. 复用现有实例不会停止它；插件的 `attach` 也**不会**在休眠时杀掉实例（SPEC §3.5）。

## 2. 本地源码安装（需要构建）

适合改源码/调试。**从源码目录安装必须先生成 `lib/`**，否则加载失败（半安装）：

```sh
git clone https://github.com/Thatgfsj/dsh-phone.git
cd dsh-phone
npm install
npm run check          # 可选：tsc + 单测 + 行数检查
npm run build          # 必需：生成 lib/（Host 逐文件转译 + Client __ModuleLoader__ bundle）
dsh plugin --profile web add .         # 目录安装（link，不复制文件）
```

重启 DSH + F5 后按 §1.2 校验。目录安装改源码后只需 `npm run build` + 重启 DSH + F5。

- `scrcpy-server` 已改为**首次使用时懒下载**（#37），无需手工跑脚本；离线/镜像见 §7。
- **从 git（`github:`）直接安装**：需要包内有构建脚本 `prepare`（#74 起提供）且 profile 批准执行
  构建脚本；未批准时只会得到没有 `lib/` 的源码包 → 半安装。**推荐 Release tgz**。
  本机实测：`dsh plugin add github:...#<tag>` 会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，按错误里打印的
  完整 key 在 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml` 加 `allowBuilds` 后重跑即可：

  ```yaml
  allowBuilds:
    "dsh-phone@https://codeload.github.com/Thatgfsj/dsh-phone/tar.gz/<commit>": true
  ```

  （key 必须用 pnpm 报错里打印的原文，含 commit；换 tag/分支后 key 会变。）
- `--profile` 必须写在转发给 pnpm 的参数**之前**（DSH 0.2.1 规则）。

## 3. 验证阶梯

```sh
# 1) 层与行（秒级、不启动）
dsh --profile web --dump-config | grep -n '^# =='          # 看层
dsh --profile web --dump-config | grep -n -A 12 'dsh-phone' # 行与配置（§1.2 必需）

# 2) Host 半边真加载（不绑端口）
dsh --profile web --patch /tmp/overlay.yml --help
# overlay.yml:
# - insert:
#     - id: dsh-phone
#       name: '/abs/path/to/dsh-phone/lib/index.js'
```

> `--patch` 仅用于冒烟验证，验证完删除 overlay；不要写进长期配置。

真实页面验收清单（重启 + F5 后）：

1. 「设置 → 手机」出现，能读写「一句话」；
2. 面板能从设置页/会话头部手机按钮打开，状态栏显示「已连接 / 硬解或软解」；
3. Agent 工具列表出现 9 个 `phone_*`；
4. `phone_status` 返回 `state`（首次可能是 `booting`，等待后重试）。

## 4. 临时 profile 验证（不影响现有配置）

```sh
dsh plugin --profile phone-verify add /abs/path/to/dsh-phone-0.2.1.tgz
dsh --profile phone-verify --dump-config | grep -n -A 12 'dsh-phone'
dsh --profile phone-verify --help            # Host 冒烟（不绑端口）
dsh plugin --profile phone-verify remove dsh-phone
rm -rf "$HOME/.dsh/profiles/phone-verify"    # 用完即删
```

注意：`dsh plugin` 自动初始化的临时 profile 只含 `dsh-base` 层，**没有 Web 前端**，
适合验证 Host 加载与配置，不适合验证右侧栏 UI。

## 5. 升级

- **Release tgz**：下载新 tgz（§1.1）→ `dsh plugin --profile web add ./dsh-phone-<new>.tgz` 覆盖安装
  → 重启 DSH + F5 → 按 §1.2 校验。
- **源码目录（link）**：`git pull && npm install && npm run build` → 重启 DSH + F5；无需重新 add。
- 升级后插件会重新生成 Agent token（旧 token 立即失效）；配置 `attach.*`/`onboarding.*` 保留。
- 升级不会自动修「半安装」：bundle 列表仍缺 `dsh-phone` 时按 §1.2 处理。

## 6. 卸载

```sh
dsh plugin --profile web remove dsh-phone
rm -f "${DSH_HOME:-$HOME/.dsh}/storages/dsh-phone/agent.json"   # 正常卸载会自动删除；残留时手动清
rm -f /path/to/dsh-phone/assets/scrcpy-server.jar                # 可选
```

- 配置数据（`attach.*`/`onboarding.*`）保留在 profile 的 `cordis.patch.yml` 中；重装可直接命中缓存（R3）。
- **卸载后刷新页面（F5）**：Host 已移除，但旧页面仍持有旧客户端模块。
- 删除 profile 目录前确认绝对路径；不要删正在使用的 `web` profile。

## 7. scrcpy-server jar（懒下载，通常无需手动处理）

视频流与控制通道（含中文 `phone_input_text`）依赖与 `@yume-chan/scrcpy` 3.3.3 匹配的 scrcpy-server：

- 首次启动流/控制通道时**自动下载**并校验 sha256（single-flight、超时、结构化错误，#37）；
- 离线/自动下载失败时，手动下载官方 asset 后放到 `assets/scrcpy-server.jar`。
  可用 `DSH_PHONE_SCRCPY_SERVER=/abs/path/scrcpy-server.jar` 覆盖；
  仓库内脚本：`node scripts/fetch-scrcpy-server.mjs`（`--check` / `--force` / `--mirror`）。
- 版本 **v3.3.3**；sha256 `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`（90164 bytes）。
- 上游许可 **Apache-2.0**（Genymobile/scrcpy）；jar **不提交仓库、不随 npm 包分发**。

## 8. 安装失败排查

优先看 [troubleshooting.md](troubleshooting.md) §1（工具缺失）、**§1.1（装了但没入口/API 404）**、§2（面板）。

常见根因：

- 从源码/git 安装但没有 `lib/`（没 build 或 `prepare` 未执行）→ 半安装，改装 Release tgz；
- profile 的 `dsh.profile.bundles` 缺 `dsh-phone`（§1.2）；
- `engines.dsh` 不匹配（DSH 版本不在 `>=0.2.1-rc.2 <0.3.0`）；
- 没重启 DSH / 没 F5；
- 按名字从 npm 安装到了另一个项目（§1.1 警告）。
