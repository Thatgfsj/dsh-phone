# Changelog

本项目的所有重要变更都会记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
