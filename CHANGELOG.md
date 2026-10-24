# Changelog

本项目的所有重要变更都会记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **首次使用守卫**（[#30](https://github.com/Thatgfsj/dsh-phone/issues/30)）：新增 `onboarding.status`
  （`pending`/`accepted`/`declined`，默认 `pending`）与 `onboarding.choice`（`""`/emulator/redroid/attach）
  两个 volatile 配置；pending 时任何 `phone_*` 工具（含 `phone_status`）返回 `E_ONBOARDING_REQUIRED`
  （不启动运行时、不安装软件、不写配置），declined 返回 `E_ONBOARDING_DECLINED`；accepted + choice
  等价显式运行时，accepted 无 choice 沿用 `runtime`。
- **设置页首次使用引导卡片**（[#31](https://github.com/Thatgfsj/dsh-phone/issues/31)）：展示三种接入方式、
  安装命令与体积（emulator 约 1.7GB），用户选择后写 `onboarding.status/choice`；拒绝后可随时重新打开；
  插件不代装任何软件。
- **首次使用文档与 Agent 技能**（[#32](https://github.com/Thatgfsj/dsh-phone/issues/32)）：`docs/usage.md`
  增加「首次使用」章节（三种方式命令与 Agent 提问流程）、`docs/config.md` 增加 onboarding 字段与语义、
  `skill/dsh-phone/SKILL.md` 增加「收到 `E_ONBOARDING_REQUIRED` 先征求用户同意」的硬流程。

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
