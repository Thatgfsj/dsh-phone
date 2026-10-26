# Changelog

本项目的所有重要变更都会记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [v0.4.1] - 2026-10-27

第六次发布：**空白桌面应用抽屉** + **面板「应用」按钮**（纯 app 与 Host/客户端小改，不动系统镜像）。

### Added

- **空白桌面应用抽屉**（[#99](https://github.com/Thatgfsj/dsh-phone/issues/99)/
  [#104](https://github.com/Thatgfsj/dsh-phone/pull/104)）：`system/feiyu-shell` 新增 `DrawerActivity`——
  首页**仍保持空白**（无图标/widget），**从屏幕底部上滑**打开 4 列应用抽屉（PackageManager 的
  MAIN/LAUNCHER：图标 + 中文名、可滚动、深色半透明、顶部搜索框按名称过滤）；点击图标启动应用，
  返回键回到空白首页；提供固定 adb 契约
  `am start -n com.dafeiyu.shell/.DrawerActivity --activity-single-top` 供 Host 调用。
  APK versionCode=2 / versionName=1.1（561KB）。
- **面板动作 API**（[#100](https://github.com/Thatgfsj/dsh-phone/issues/100)/
  [#105](https://github.com/Thatgfsj/dsh-phone/pull/105)）：`POST /dsh-phone/api/action` body
  `{action:'app-drawer'}`——只允许**预定义动作 + 固定命令**（不做任意命令拼接），经 scrcpy 控制通道执行；
  不可用返回 **409 `E_APP_DRAWER_UNAVAILABLE`**，生命周期动作进行中返回 **409 `E_LIFECYCLE_BUSY`**。
- **面板底部「应用」按钮**（[#101](https://github.com/Thatgfsj/dsh-phone/issues/101)/
  [#103](https://github.com/Thatgfsj/dsh-phone/pull/103)）：宽屏图标 + 文字、窄屏仅图标（`title`/`aria` 保留）；
  点击后轻提示「已打开应用抽屉」；请求期间按钮 busy 防重复；409 时给专属可读文案（提示更新定制或运行
  `system/provision-device.sh`）；Host 未实现 `/action` 时也只显示失败提示，不影响其余按键。

### Changed

- **README 用户修改并入**（[#102](https://github.com/Thatgfsj/dsh-phone/pull/102)）：版本状态段按用户口径
  精简（不再强调「无 YouTube」）；本次同时补「上滑打开应用抽屉」与面板「应用」按钮说明。
- **文档**：`docs/usage.md` 新增 §2.3（应用抽屉的两种入口与错误文案）；`docs/verification.md` §10 记录
  #99 抽屉实测（空白首页 / 上滑打开 / adb 固定命令 / 从抽屉启动「设置」/ 返回 HOME 仍空白，均 PASS）；
  README 与 `docs/install.md` 的版本与 tgz 名同步 0.4.1。
- 版本号 `0.4.0` → `0.4.1`（[#106](https://github.com/Thatgfsj/dsh-phone/issues/106)）。

### 已知限制与未验证项

- **沿用 v0.4.0**：[#72](https://github.com/Thatgfsj/dsh-phone/issues/72)（phone_key 白名单/screenshot 掩码/
  booting 断连/control 单飞）未完成；#40 剩余真实浏览器/redroid/审批 UI 人工待办；冷启动 33–95s 有客观下限；
  `aosp_atd` 未实测；npm 包名冲突未改名。
- **应用抽屉依赖定制 app**：未安装 `system/feiyu-shell`（或用户自己换了 launcher）的实例上 `/action`
  返回 409、面板显示专属提示——这是预期行为，不是缺陷。
- **抽屉搜索框未做自动化输入验证**；抽屉内应用列表取决于设备已安装的 MAIN/LAUNCHER 应用（当前验证设备
  只剩「设置 / TMobile」）。
- 应用抽屉由 app 自身绘制，Host 只发固定 adb 命令、不解析界面；`/action` 不接受任意命令/参数。

## [v0.4.0] - 2026-10-27

第五次发布：**生命周期控制**（启动 / 停止 / 重启 + 外部 kill 兜底）与 **肥鱼手机定制**（一键把实例变成「大肥鱼的手机」）。

### Added

- **生命周期控制三端打通**（[#83](https://github.com/Thatgfsj/dsh-phone/issues/83)）：Host API
  （[#84](https://github.com/Thatgfsj/dsh-phone/issues/84)：`GET /dsh-phone/api/runtime` 返回
  state/running/owned/adopted/pid/endpoint/since/busy/lastError；`POST /dsh-phone/api/runtime`
  `{action:'start'|'stop'|'restart'}` 返回 202 由 UI 轮询；**`stop` 只允许浏览器同源鉴权**，
  Agent token 只能 start/restart）、客户端 UI（[#85](https://github.com/Thatgfsj/dsh-phone/issues/85)：
  面板 header 状态徽章 + 重启/关闭按钮、停止或被外部关闭后的空态与「启动手机」大按钮、动作进度与失败重试、
  设置页同入口与所有权说明）、runtime（[#86](https://github.com/Thatgfsj/dsh-phone/issues/86)：
  `RuntimeStatus.owned/adopted` + `adapter.isAlive()`、**2s 看门狗**——外部 `kill -9` 后 ≤2s 变
  `stopped` 并给出可读原因、`start/stop/restart` 单一互斥 + 超时、`dispose()` 按所有权收尾
  （owned 停机并保存快照、adopted 只断开），**5s 硬预算**避免卡住插件卸载）。
- **肥鱼手机定制层**（[#87](https://github.com/Thatgfsj/dsh-phone/issues/87)、
  [#96](https://github.com/Thatgfsj/dsh-phone/pull/96)）：新增 `system/`——`wallpapers/{111,222}.png`
  （720x1280）、`feiyu-shell/`（极简空白 HOME app：Java 源码 + `build.sh` + 预构建 `feiyu-shell.apk`，
  双壁纸轮换）、`provision-device.sh`（幂等：设壁纸/装 app/设 HOME/删 YouTube/切中文/重启/校验/截图）、
  `avd-config.ini`、`README.md`（来源与许可）。**实机验证**：AVD **1080x2400**、`zh-CN`、
  空白首页（无图标/widget）、壁纸 111/222 轮换、YouTube 已卸载。
- **一键准备自动应用定制**（[#88](https://github.com/Thatgfsj/dsh-phone/issues/88)/
  [#94](https://github.com/Thatgfsj/dsh-phone/pull/94)）：provisioning 新增 `step=customize`
  （装好 Android 后自动应用肥鱼定制，失败不阻断、日志可查）；`package.json` 的 `files` 纳入 `system/`，
  `description` 改为「这是大肥鱼的手机，主人不要动大肥鱼的手机喵」。
- **生命周期客户端验收**（[#92](https://github.com/Thatgfsj/dsh-phone/issues/92)/
  [#95](https://github.com/Thatgfsj/dsh-phone/pull/95)）：11 个独立单测（动作状态机 / 错误映射 /
  owned vs adopted 文案 / 轮询）+ `docs/client.md` §4.5 人工核对清单。

### Fixed

- **#86 合并后 main 无法编译**（[#90](https://github.com/Thatgfsj/dsh-phone/pull/90)，
  Part of [#83](https://github.com/Thatgfsj/dsh-phone/issues/83)）：`src/phone/contracts.ts` 的
  `PhoneStatus` 去掉重复字段 `owned/adopted/pid`（#84 与 #86 各加一份 → TS2300）；
  `src/phone/service.ts` 从 1159 行拆分到 **893 行**（新增 `service-types.ts`/`service-helpers.ts`/
  `control.ts`/`usage.ts`，满足 1000 行硬线），并补 #83 专项测试。

### Changed

- **文案**（[#89](https://github.com/Thatgfsj/dsh-phone/issues/89)/
  [#93](https://github.com/Thatgfsj/dsh-phone/pull/93)）：`locale/zh.json`、`locale/en.json` 与 README
  首段改为「这是大肥鱼的手机，主人不要动大肥鱼的手机喵」（标题「肥鱼的手机」保留）。
- **文档**：README（版本/状态/能力/安装 tgz；新增肥鱼手机截图
  `docs/screenshots/feiyu-home-{1,2}.webp`；指向 [system/README.md](system/README.md)）、
  `docs/install.md`（版本与 tgz 名、包内新增 `system/`）、`docs/verification.md`（新增 §9：
  #87 实机结果与 #83 单测覆盖）、`docs/usage.md`（生命周期按钮与肥鱼手机行为）。
- 版本号 `0.3.0` → `0.4.0`（[#97](https://github.com/Thatgfsj/dsh-phone/issues/97)）。

### 已知限制与未验证项

- **未完成**：[#72](https://github.com/Thatgfsj/dsh-phone/issues/72)（phone_key 白名单 / screenshot 掩码 /
  booting 断连 / control 单飞）仍在跟踪。
- **#40 剩余项**：真实浏览器渲染/WebCodecs/TinyH264 的人工验收、redroid（本机无 Docker）、
  `phone_shell` 审批 UI 点击仍是人工待办；详见 [docs/verification.md](docs/verification.md) §4/§5。
- **冷启动 33–95s** 有客观下限（Android 14 google_apis）；`aosp_atd` 未实测；温启动 ~15s 为本机数据。
- **npm 包名冲突未改名**：npm 上的 `dsh-phone` 属于另一个项目（PonyDevAI/dsh-phone），本仓库未发布
  registry；必须用 Release tgz、源码目录或 git 安装。
- **肥鱼定制只在单一组合验证**：`system-images;android-34;google_apis;x86_64` +
  AVD `medium_phone`（1080x2400 @420dpi）；其他 API/ABI/设备档位与 Windows/macOS 宿主未验证；
  `provision-device.sh` 幂等，但不承诺跨镜像一致。
- **生命周期动作语义**：adopted 实例的「停止」= 断开连接（不杀用户的模拟器/真机）；`stop` 只能由用户
  在浏览器里触发（Agent token 仅 start/restart），这是防自我授权红线，不是缺陷。

## [v0.3.0] - 2026-10-26

第四次发布：**开箱即用**（一键准备运行环境）与 **emulator 启动速度专项**。

### Added

- **一键准备运行环境**（[#65](https://github.com/Thatgfsj/dsh-phone/issues/65)、
  [#66](https://github.com/Thatgfsj/dsh-phone/issues/66)）：Provisioning API
  （`GET /dsh-phone/api/provision` 返回 state/step/percent/log/error；`POST /dsh-phone/api/provision`
  启动或复用，幂等）与首次使用/设置页的「一键准备并启用」UI（进度、日志、可取消、失败重试）；
  emulator 路径会安装 emulator + system image（默认 `android-34;google_apis;x86_64`）、接受许可、
  创建 AVD，done 后自动写 `onboarding.accepted`。**仅浏览器同源鉴权触发**，Agent token 通道不允许
  自动安装软件。
- **emulator 启动专项**（[#67](https://github.com/Thatgfsj/dsh-phone/issues/67)）：quick-boot 快照
  自检/保存/加载；`boot_completed` + package manager 就绪检测；复用已运行实例（adopt）；
  emulator spawn 日志与 FATAL 分类；AVD device profile；取消孤儿进程；空闲阈值 5min → **20min**
  （观看也计为交互）；新增 `lifecycle.prewarm`（默认 false）；`scripts/verify/measure-boot.mjs` 测量脚本。
  **实测**：温启动（有效快照）进程→首帧 **~15s**、暂停恢复 **~19s**（≤20s 目标达成）；
  冷启动 **33–95s**（Android 14 google_apis 存在客观下限，未达成 20s）；`aosp_atd` 快镜像未实测。
  数据见 [docs/verification.md](docs/verification.md)、[docs/runtime.md](docs/runtime.md)。
- **安装与打包可用性**（[#74](https://github.com/Thatgfsj/dsh-phone/issues/74)）：`package.json` 增加
  `prepare`（git 安装可构建 `lib/`）；GitHub Release 上传预构建 tgz 资产；新增
  `scripts/install-check.mjs`（dependency/bundles/dump-config/API 四项自检与修复建议）；复用已有
  emulator 实例指引。

### Fixed

- **attach.endpoint 写入生效 + R4b 真实验证**（[#70](https://github.com/Thatgfsj/dsh-phone/issues/70)）：
  运行时指纹纳入 `attach.endpoint/resolved`；变化时丢弃旧 adapter/ADB 连接并强制重连；R4b 在新连接上
  真实校验，不再假通过；覆盖旧端点场景测试。
- **Agent 通道安全收紧**（[#71](https://github.com/Thatgfsj/dsh-phone/issues/71)）：Agent token 通道
  不再能写 `onboarding.status/choice`（防自我授权绕过首次使用守卫）；`getOrigin()` 未 listen 时
  try/catch 回退，避免 API/WS 注册整体失败；写入 **revision CAS 必填**；`/attach/verify` 限制 loopback
  与端口 ≥1024；verified 记录带 **TTL**（5 分钟）。
- **视频流与生命周期修复**（[#73](https://github.com/Thatgfsj/dsh-phone/issues/73)）：viewer 存活期间
  每 60s 心跳计入交互（观看视频不再被 idle 暂停）；引用计数引入代际（旧 viewer 的 release 不会
  关掉新流）；WS 背压（发送积压时 delta 丢弃，configuration/keyframe 超限以 1011 `E_STREAM_BACKPRESSURE`
  断开重连）；服务端 60s 空闲超时（1011 `E_STREAM_IDLE`）；双页互踢改为 close **4001**
  （`E_STREAM_REPLACED`，客户端提示「已在另一处打开」并停止自动重连）。
- **面板布局重做**（[#62](https://github.com/Thatgfsj/dsh-phone/issues/62)、
  [#63](https://github.com/Thatgfsj/dsh-phone/issues/63)，v0.2.1 已发布）：拆分 header/stage/footer、
  布局断点 + `@container (max-width: 360px)`、长文本块，修复竖排单字/booting 黑屏/header/footer 拥挤。

### Changed

- **安装首公里文档**（[#75](https://github.com/Thatgfsj/dsh-phone/issues/75)）：README/install/troubleshooting
  改为 Release 预构建 tgz 优先、安装后 `--dump-config` 校验、半安装修复、重启 DSH 与 F5 区别、
  复用已运行 emulator（attach）指引。
- 版本号 `0.2.1` → `0.3.0`（[#80](https://github.com/Thatgfsj/dsh-phone/issues/80)）；
  README/install 的版本与 tgz 名同步。

### 已知限制与未验证项

- **未完成**：[#72](https://github.com/Thatgfsj/dsh-phone/issues/72)（phone_key 白名单/screenshot 掩码/
  booting 断连/control 单飞）、[#40](https://github.com/Thatgfsj/dsh-phone/issues/40) 剩余真实浏览器验收。
- **启动时间**：冷启动 33–95s 有客观下限（Android 14 google_apis）；`aosp_atd` 未实测；温启动 ~15s /
  暂停恢复 ~19s 为本机实测，不代表所有机器。
- **真实浏览器渲染/WebCodecs/TinyH264**：未端到端验证；解码失败会自动回退软解。
- **npm 包名冲突未改名**：npm 上的 `dsh-phone` 属于另一个项目（PonyDevAI/dsh-phone），本仓库未发布
  registry；必须用 Release tgz、源码目录或 git 安装。
- **一键准备**需用户点击且浏览器同源触发（Agent token 不允许自动安装软件）；安装体积/时长取决于网络
  与 system image，失败时保留日志供重试。
- **单实例**（`limits.maxInstances: 1`）、`cpuPct/memPct` 尽力而为、scrcpy-server jar 懒下载等既有约束
  不变；详见 [docs/verification.md](docs/verification.md)。

## [v0.2.1] - 2026-10-25

补丁版：重做手机面板前端布局，修复长文本被挤成竖排单字、booting 黑屏与 header/footer 拥挤（#62）。

### Fixed

- **手机面板前端布局重做**（[#62](https://github.com/Thatgfsj/dsh-phone/issues/62)）：面板拆分为
  `panel-header` / `panel-stage` / `panel-footer` 三个组件，新增 `layout.ts` 纯函数提供宽度断点
  （≤360 compact / <600 regular / ≥600 wide）、stage overlay 判定（error > booting > canvas）与 booting 摘要；
  窄屏使用 `container-type: inline-size` + `@container (max-width: 360px)` 收起 footer 文字标签；
  长文本/endpoint/错误 message 统一按行换行（**不再竖排单字**）；booting 由 stage 层进度 overlay 呈现
  （spinner + phase + 已等待/预计时间，**不再黑屏**）；header 状态徽章与 footer 5 个设备按键紧凑排列，
  320px 下不溢出、无横向滚动条。单测覆盖断点/overlay 优先级/booting 摘要。

## [v0.2.0] - 2026-10-25

第二次发布：首次使用守卫（onboarding）、右侧栏入口与自动打开、冷启动健壮性，以及 emulator 方向的一批修复。
用户要求「修完再发」，因此本版本包含 #36/#44/#56/#59 等修复后才发布。

### Added

- **首次使用守卫（onboarding）**（[#30](https://github.com/Thatgfsj/dsh-phone/issues/30)、
  [#31](https://github.com/Thatgfsj/dsh-phone/issues/31)、[#32](https://github.com/Thatgfsj/dsh-phone/issues/32)）：
  新增 `onboarding.status`（`pending`/`accepted`/`declined`，默认 `pending`）与 `onboarding.choice`
  两个 volatile 配置；pending 时 9 个 `phone_*` 工具（含 `phone_status`）返回 `E_ONBOARDING_REQUIRED`
  （不启动运行时、不安装软件、不写配置），declined 返回 `E_ONBOARDING_DECLINED`；设置页与面板内嵌
  引导卡展示三种接入方式与安装命令；SKILL 增加「先向用户说明代价并取得明确答复」的硬流程。
- **会话头部手机入口、自动打开与面板空态**（[#45](https://github.com/Thatgfsj/dsh-phone/issues/45)）：
  `conversation.session.header.utilities` 增加手机图标按钮（任意会话可见）；面板在
  `pending`/`declined`/Host 不可用时显示可读空态与内嵌引导卡，不黑屏。
- **pending 也自动打开面板 + 首帧重试**（[#47](https://github.com/Thatgfsj/dsh-phone/issues/47)）：
  自动打开条件改为 `onboarding.status !== 'declined'`；pending 时由面板首屏直接征询同意；
  面板首帧读取增加短暂重试，避免 Host 冷启动时闪出错误/不可用。
- **GET /config 暴露 `enabled` 只读字段**（[#52](https://github.com/Thatgfsj/dsh-phone/issues/52)）：
  主 handler 与 `enabled=false` 的只读 handler 同形，设置页可只读展示插件开关状态。
- **客户端 booting 进度与 enabled 展示**（[#39](https://github.com/Thatgfsj/dsh-phone/issues/39)）：
  面板在 booting 时每秒轮询 `/status` 展示进度（`bootMs` + `phase`：launching/waiting-adbd/connecting-adb/ready）；
  设置页只读展示 `enabled` 状态并据此禁用编辑。
- **scrcpy-server 懒下载**（[#37](https://github.com/Thatgfsj/dsh-phone/issues/37)）：首次启动时自动下载并
  sha256 校验（single-flight、超时、结构化错误），不再要求用户先手工跑脚本；仍支持
  `DSH_PHONE_SCRCPY_SERVER` 覆盖。
- **可复制安装命令单一数据源**（[#38](https://github.com/Thatgfsj/dsh-phone/issues/38)）：运行时不可用/
  引导卡中的安装命令集中为单一数据源，文档与工具返回一致。

### Fixed

- **探测失败不再永久缓存**（[#36](https://github.com/Thatgfsj/dsh-phone/issues/36)）：运行时探测失败结果
  30s 防抖后失效；配置变更/断连可触发重新探测，不再需要重启 DSH。
- **冷启动 ADB/截图重试与 lastError 清理**（[#44](https://github.com/Thatgfsj/dsh-phone/issues/44)）：
  冷启动窗口内 ADB 连接与 `screencap` 增加重试；成功后清理 `lastError`，避免残留旧错误。
- **runtime emulator 健壮性**（[#56](https://github.com/Thatgfsj/dsh-phone/issues/56)）：`avdmanager` 多路径
  查找、AVD 名前缀匹配、空闲端口选择、cpu/mem 采样（Linux `/proc` / redroid `docker stats` /
  attach `dumpsys`，取不到省略）与 booting `phase` 阶段。
- **Host → stream 接线修复**（[#59](https://github.com/Thatgfsj/dsh-phone/issues/59)）：视频流/控制通道传
  `AdbConnection` 而非 `.raw`，修复真实链路下 scrcpy 启动的接线错误。

### Changed

- **动态安装后需刷新页面**（[#48](https://github.com/Thatgfsj/dsh-phone/issues/48)）：安装/更新/启用插件后
  必须刷新浏览器页面（F5）——客户端模块在页面启动时入图，HMR 不会向已打开页面注入新模块；
  刷新不中断会话与手机实例。文档与 SKILL 增加「工具可用但看不到手机入口」的三步排查。
- **真实 emulator attach 验收已通过**（[#40](https://github.com/Thatgfsj/dsh-phone/issues/40)、
  [#58](https://github.com/Thatgfsj/dsh-phone/issues/58)）：真实 emulator（720x1280）attach 全链路 PASS——
  Host WS 10s 收 **102 帧**（config/keyframe/delta，DPH1 合法）、stream 层直连对照 51 帧/5s、
  控制通道/中文输入（INJECT_TEXT）/截图（PNG 720x1280、775ms）均 PASS；见
  [docs/verification.md](docs/verification.md) §2 行 10–12 与 §7。emulator 自启（B 分支）与真实浏览器渲染仍待人工。
- 版本号 `0.1.0` → `0.2.0`（[#51](https://github.com/Thatgfsj/dsh-phone/issues/51)）。

### 已知限制与未验证项

- **#40 部分完成**：真实 emulator attach 与 scrcpy 实连已通过（#58，见 §7）；仍待人工/环境的项：
  emulator 自启（B 分支，需停用用户 live 实例）、真实浏览器渲染/WebCodecs/TinyH264、redroid（本机无 Docker）、
  `phone_shell` 审批 UI 点击；完整矩阵、SKIP 原因与人工待办见 [docs/verification.md](docs/verification.md) §2/§4/§5。
- **平台限制**：Windows/macOS 的 emulator 参数、WSL2 + redroid 属未本机验证路径；redroid 需 Docker + binder。
- **单实例**：`limits.maxInstances: 1`，所有工具无 serial 参数。
- **cpuPct/memPct 为尽力而为**：emulator/redroid/attach 各自采样，取不到就省略字段，不阻断 status；
  不要把它们当精确监控。
- **`phone_screenshot` 未探测模型图片能力**：仅捕获 attachment 保存失败并降级文本。
- **一句话的候选路径/端口探测由操作 Agent 完成**：插件不扫盘，只提供 `/attach/verify` 与单键写入。
- **scrcpy-server jar 不随包分发**：懒下载失败时仍可用 `DSH_PHONE_SCRCPY_SERVER` 或
  `node scripts/fetch-scrcpy-server.mjs` 手动放置。
- **设置页 `enabled` 只读**：开关变更仍需插件管理/profile 配置（非 volatile，改动需重载）。

## [v0.1.0] - 2026-10-25

首个可用版本：给 DeepSeek Harness（DSH）提供一台运行在后端的 Android 实例，经浏览器右侧栏呈现，
并注册 9 个 `phone_*` 工具供 Agent 操作。

### Added

- **仓库治理与校准**（[#1](https://github.com/Thatgfsj/dsh-phone/issues/1)、[#2](https://github.com/Thatgfsj/dsh-phone/issues/2)）：
  Issue → 分支 → PR 流程、构建期 CI（仅 `v*` tag / `workflow_dispatch`）、单文件 1000 行硬线；
  DSH 0.2.1-rc.2 集成点源码校准与架构/协议契约（`docs/calibration.md`、`architecture.md`、`protocol.md`）。
- **运行时与 ADB 层**（[#3](https://github.com/Thatgfsj/dsh-phone/issues/3)）：redroid / emulator / attach 三适配器
  与 `auto` 决策树（禁止跳步，失败给平台安装指引）；`@yume-chan/adb` 纯 TS 直连 TCP adbd（不依赖宿主机 adb 二进制）；
  `PhoneLifecycle` 懒启动 / single-flight / booting 中间态 / 5min idle → paused / 30min → stopped。
- **Host 半边**（[#4](https://github.com/Thatgfsj/dsh-phone/issues/4)）：SPEC §6.1 全量 Schemastery 配置
  （`attach.endpoint/userHint/resolved` 三键 volatile）、`PhoneService`、9 个 `phone_*` 工具、
  `phone_shell` 默认 ask 审批（`getprop` / `wm size` / `dumpsys` 只读子集免确认）、
  `/dsh-phone/api/*` HTTP 路由、本地 Agent token 通道（R1–R5：单键写入 + 回读 + 先验证后落盘）。
- **视频流**（[#5](https://github.com/Thatgfsj/dsh-phone/issues/5)）：scrcpy-server v3.3.3（脚本下载 + sha256 校验，
  jar 不随包分发）、H.264 零转码透传、`DPH1` 8 字节帧头、WebSocket 传输、控制通道（中文 INJECT_TEXT /
  触摸 / 按键）、viewer 引用计数与 5s 宽限停流、无 viewer 时 control-only 不编码视频。
- **Web 客户端**（[#6](https://github.com/Thatgfsj/dsh-phone/issues/6)）：右侧栏 tab 面板
  （`sidebarRightTabs` + `sidebar.right.pane.tab`，不遮蔽官方右栏）、WebCodecs 硬解 + TinyH264 WASM 软解回退、
  `IntersectionObserver` + `visibilitychange` 双可见性断流、设置页（一句话 / 解析状态 / 重置 / 打开面板）。
- **文档与技能**（[#7](https://github.com/Thatgfsj/dsh-phone/issues/7)）：README、安装/使用/配置/排障/第三方许可文档，
  以及可直接安装的 Agent 技能 `skill/dsh-phone/SKILL.md`。
- **依赖基线**（[#11](https://github.com/Thatgfsj/dsh-phone/issues/11)、[#17](https://github.com/Thatgfsj/dsh-phone/issues/17)）：
  `@yume-chan/*` 与 `tinyh264`（Apache-2.0，仅 client bundle）；宿主共享的 `@deepseek-ai/*` 只放
  `peerDependencies` + `devDependencies`；`engines.dsh` 锁定 `>=0.2.1-rc.2 <0.3.0`。

### Fixed

- **设备分辨率与触摸坐标**（[#20](https://github.com/Thatgfsj/dsh-phone/issues/20)）：`ready` 增加
  `deviceWidth/deviceHeight`（`adb shell wm size`），触摸坐标按设备尺寸 → 视频尺寸（`maxSize` 降采样）换算，
  修复 1080p 真机在 720p 流下的点击偏移。
- **重连错误残留**（[#22](https://github.com/Thatgfsj/dsh-phone/issues/22)）：重连时清空上一次错误帧信息，避免误报。

### Changed

- 版本号 `0.0.0` → `0.1.0`（[#23](https://github.com/Thatgfsj/dsh-phone/issues/23)）。

### 已知限制与未验证项

- **单实例**：`limits.maxInstances: 1`，所有工具无 serial 参数。
- **本机未端到端验证**：开发机无 Docker、无 emulator 包/AVD、attach 端口不可达。redroid、emulator、
  真实 attach、scrcpy 实连（pushServer/视频/控制）、`phone_shell` 审批 UI、真实浏览器渲染均只有
  单元测试与静态验证；详见 `docs/runtime.md` §6、`docs/stream.md` §8、`docs/client.md` §6。
- **`cpuPct/memPct` 未实现**：`phone_status` 中这两个字段当前始终缺省。
- **`phone_screenshot` 的模型图片能力未探测**：仅捕获 attachment 保存失败并降级文本。
- **一句话的候选路径/端口探测由操作 Agent 完成**：插件不扫盘，只提供 `/attach/verify` 与单键写入。
- **scrcpy-server jar 不随包分发**：需 `node scripts/fetch-scrcpy-server.mjs` 或设
  `DSH_PHONE_SCRCPY_SERVER`；版本必须与 `@yume-chan/scrcpy` 3.3.3 匹配。
- **Windows WSL2 + redroid 属进阶路径**；Windows/macOS 的 emulator 参数未在本机验证。
- **设置页没有 `enabled` 开关**（非 volatile）：关闭插件请用插件管理或 profile 配置。
