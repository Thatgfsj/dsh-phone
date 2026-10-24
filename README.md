# dsh-phone

> 肥鱼的手机：给 DeepSeek Harness（DSH）提供一台运行在后端、经浏览器右侧栏呈现的 Android 实例，并注册 9 个 `phone_*` 工具供 Agent 直接操作。

[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![files ≤1000 lines](https://img.shields.io/badge/file-%E2%89%A41000%20lines-brightgreen)](CONTRIBUTING.md)

> **状态：骨架阶段**。本仓库当前只有交付骨架与治理文件（[#1](https://github.com/Thatgfsj/dsh-phone/issues/1)）；运行时层、ADB 通道、scrcpy 视频流、右侧栏面板与 phone_* 工具将在后续 issue/PR 中实现。需求原文见 [docs/SPEC.md](docs/SPEC.md)。

## 目标能力

- **9 个 `phone_*` 工具**：`phone_status` / `phone_screenshot` / `phone_tap` / `phone_swipe` / `phone_key` / `phone_input_text` / `phone_app_launch` / `phone_uiautomator_dump` / `phone_shell`。
- **三种运行时 + auto 探测**：redroid（Docker 容器）/ Android SDK Emulator（KVM / WHPX / HVF）/ attach（用户本机模拟器或真机）。
- **懒启动与分级休眠**：首次工具调用或首次打开面板才拉起实例；5 分钟无交互进 paused，30 分钟或资源紧张进 stopped。
- **双链路解耦**：Agent 只看按需单帧截图（约 100–300ms、零持续开销）；人看 scrcpy H.264 视频流（720p / 15fps / 2Mbps，仅面板可见时传输，Host 零转码）。
- **首次接入「一句话」解析**：用户填一句话（如「模拟器在 D:\Android\Sdk」），插件自动发现可执行文件路径与 adb TCP 端口，连通验证后只定点写入 `attach.endpoint` 与 `attach.resolved` 两个字段。

## 安装

> 尚未发布，当前不可安装；以下为预期用法，实现完成后随 README 更新。

```sh
git clone https://github.com/Thatgfsj/dsh-phone.git
cd dsh-phone
npm install
npm run build
dsh plugin --profile web add .
```

要求：DSH `>=0.2.1-rc.2 <0.3.0`；Node `>=20`。

## 目录结构

```
.
├── docs/            # SPEC.md（需求原文）与实现、校准文档
├── locale/          # 中文 / 英文展示元数据（meta.title / meta.description）
├── scripts/         # 构建脚本与仓库自检脚本
├── src/             # 插件源码（Host / client / runtime / adb / stream / tools）
├── tests/           # node --test 单测
├── cordis.patch.yml # bundle 配置层（insert dsh-phone）
├── icon.svg         # 插件图标（顶层 icon 字段）
└── package.json     # DSH 插件元数据（dsh.bundle / dsh.client / engines）
```

## 开发

```sh
npm install                      # 安装 devDependencies（esbuild / typescript / @types/node）
npm run check                    # typecheck + node --test + 单文件行数检查
npm run build                    # -> lib/（构建产物，不提交）
node scripts/check-file-lines.mjs
```

- 构建：Host 逐文件 esbuild 转译（`bundle: false`，`outbase src`），Client 打包为 `window.__ModuleLoader__.load` 包装的 `lib/client.js`；当前没有源码时构建直接成功退出。
- 测试：`node --test`，测试文件放 `tests/`。

## 已知限制

- 首版单实例（`maxInstances: 1`），所有工具无 serial 参数。
- 本机验证环境没有 Docker：redroid 适配器以单测覆盖为主，未做集成验证。
- 需要宿主机具备 Docker（binder）/ Android SDK Emulator / 可连通的本机模拟器之一；插件不安装任何软件。

## 参与贡献

任何改动都必须先开 Issue、再开 PR；CI 只在推 `v*` tag 或手动触发时运行。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

## 协议

MIT，见 [LICENSE](LICENSE)。
