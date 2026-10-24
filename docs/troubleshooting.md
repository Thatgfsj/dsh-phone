# 排障与错误码

> 先跑「快速自检」，再按现象查表。实现细节：[host.md](host.md) §5.2、[runtime.md](runtime.md) §6、
> [stream.md](stream.md) §8、[client.md](client.md) §6。

## 0. 快速自检

```sh
dsh --version                                   # 应为 0.2.1-rc.x
node --version                                  # >=20
dsh --profile web --dump-config | grep -n -A 12 'dsh-phone'   # 行是否存在
ls -l lib/index.js lib/client.js                # 构建产物
ls -l assets/scrcpy-server.jar                  # 视频/控制通道依赖
ldd /dev/null >/dev/null 2>&1 || true
docker info 2>/dev/null | head -3               # redroid 前提
ls -l /dev/binder /dev/kvm 2>/dev/null          # redroid / emulator 前提
node scripts/fetch-scrcpy-server.mjs --check    # jar 校验
```

## 1. 装了但没反应 / 工具列表没有 phone_*

| 可能原因 | 确认 | 处理 |
|---|---|---|
| 没跑构建，`lib/` 不存在 | `ls lib/index.js` | `npm run build` 后重启 DSH |
| 装错 profile | `dsh --profile <p> --dump-config \| grep dsh-phone` | 用当前启动的 profile 重新 `dsh plugin add` |
| 插件行被禁用 | `--dump-config` 看该行 `disabled` | 插件管理启用；或删掉禁用覆盖 |
| `enabled: false` | `--dump-config` 看 config.enabled | 由用户改回（Agent 不得改） |
| DSH 版本不匹配 | `dsh --version` 不在 `>=0.2.1-rc.2 <0.3.0` | 升级/降级 DSH |
| 没重启 DSH | 手工 `--patch overlay --help` 能看到 apply 日志 | 重启 DSH（不是刷新页面） |
| peer 依赖解析失败 | 从插件目录 `node -e "import('@deepseek-ai/dsh-tools')"` 报 `ERR_MODULE_NOT_FOUND` | 确认 `npm install` 且 `@deepseek-ai/*` 只在 peer+dev；重装 |

## 2. 面板/设置页不出现

| 现象 | 原因 | 处理 |
|---|---|---|
| 设置里没有「手机」 | 客户端 bundle 未加载：`lib/client.js` 缺失、没重启、包里 `dsh.client` 缺失 | `npm run build`；重启；`package.json` 的 `exports["./client"]` 与 `dsh.client` 必须存在 |
| 有设置页但没有「打开手机面板」 | 客户端在旧模块代 | 强制刷新页面 + 重启 DSH |
| 面板打开后一直「未连接/重连中」 | 无 web carrier / 非 loopback / 跨站打开 | 在 DSH 本机页面打开；`http://127.0.0.1:<port>` |
| 面板黑屏但状态「已连接」 | WebCodecs 解码失败且软解也失败 | 换 Chrome/Edge；看控制台 `decoder` 错误；确认硬解/软解标识 |

## 3. 实例与运行时

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `E_RUNTIME_UNAVAILABLE` | 三运行时均不可用 | 看错误里的 hints：Linux 检查 docker + `/dev/binder` 或 `/dev/kvm`；Windows/macOS 检查 SDK Emulator；或改用 attach |
| `state=booting` 超过 60s | 冷启动慢/前置条件不足（Docker 镜像未拉、AVD 首次启动、KVM 缺失） | 报告 runtime/平台；检查 `phone_status.lastError`；redroid 首次拉镜像可能更久；不要盲目重试 |
| attach 唤醒后连接失败 | 用户关掉了模拟器/真机，或端口变了 | 提示用户重新拉起；**不要自动重写配置**；重新接入需用户重置 `resolved` |
| attach 一直连不上 | adb TCP 端口不可达、实例未开 adb tcpip、防火墙 | 宿主机端口连通性测试；确认模拟器的 adb 调试端口；部分模拟器需在设置里开启网络桥接 |
| emulator 启动即退出 | AVD 不存在、system image 未安装、WHPX/HVF 不可用 | 看 hints；用 Android Studio 创建 AVD；确认 BIOS 虚拟化 |
| redroid 启动失败 | Docker 无权限、binder 未加载、端口占用 | `docker info`；`sudo modprobe binder_linux`；换端口 |

## 4. HTTP / 配置写入

| HTTP | code | 含义 | 处理 |
|---|---|---|---|
| 400 | `E_BAD_REQUEST` | JSON/字段/endpoint 格式非法 | 修正 body；endpoint 必须 `host:port` |
| 400 | `E_BAD_PATH` | 写入路径不在三键白名单 | 只写 `attach.endpoint/resolved/userHint` |
| 401 | `E_AUTH` | 未通过 DSH connection 认证 | 浏览器方式：在 DSH 页面内操作；Agent 方式：重读 token 文件 |
| 403 | `E_FORBIDDEN` | Agent 通道试图写 `userHint`（R2） | 让用户在设置页修改一句话 |
| 403 | `E_ORIGIN` | Origin/Host 未通过同源校验 | 从 DSH 同源页面发起请求 |
| 409 | `E_CONFIG_CONFLICT` | settings revision 冲突 | 客户端会自动刷新 revision 重试一次；仍失败则刷新设置页 |
| 409 | `E_NOT_VERIFIED` | 未 verify 就写 endpoint/resolved=true（R5） | 先 `POST /attach/verify`（同一进程内有效） |
| 502 | `E_DEVICE_DISCONNECTED` | 写后复验未 running（配置可能已落盘） | 检查实例；再次 `phone_status`；必要时重新 verify |
| 503 | `E_NO_WEB` | 无 web carrier / settings 缺失 / 插件关闭的非只读路由 | 用 web profile；确认插件启用 |
| 200 | `E_BOOTING`（JSON） | 截图路由遇到启动中 | 等待后重试 |

## 5. 操作类

| 现象 | 处理 |
|---|---|
| `phone_tap` 后画面无变化 | 先用 `phone_uiautomator_dump` 确认实际 bounds；再检查实例是否卡顿；必要时 `phone_status` 看状态 |
| 中文输入乱码/丢失 | 必须用 `phone_input_text`（INJECT_TEXT）；若控制通道不可用会报 `E_DEVICE_COMMAND`，检查 scrcpy-server jar |
| 点击位置偏移（1080p 真机缩放到 720p 流） | 客户端按 `wm size` 设备分辨率换算；若 `wm size` 解析失败会退回画面尺寸导致偏移——更新到修复版本或临时把 `stream.maxSize` 设为 `0`（不缩放） |
| `phone_shell` 一直等审批 | 非白名单命令需要用户在审批 UI 点「允许一次」；查询类命令用白名单形式（`getprop` / `wm size` / `dumpsys` 只读 service） |
| 截图只有文字没有图片 | 当前会话/模型不支持图片附件，或没有 attachment 服务；已按设计降级文本，可改用 `phone_uiautomator_dump` 拿坐标 |
| Agent 调用 HTTP 401 | token 过期（插件重载轮换）/路径写错；重读 `agent.json`；确认 `$DSH_HOME` 一致 |
| 设置页保存失败 | 看错误文案：`E_NOT_VERIFIED` → 先接入验证；`E_CONFIG_CONFLICT` → 刷新后重试；403 → 不要在 Agent 侧改 userHint |

## 6. 性能与资源

| 现象 | 处理 |
|---|---|
| 面板画面卡顿/延迟高 | 硬解是否生效（面板显示「硬解 WebCodecs」）；否则换 Chrome/Edge；降低 `stream.maxSize/maxFps/bitrate` |
| 看视频时整机 CPU 高 | 软解回退在主线程解码，CPU 明显更高；优先硬解；必要时降低参数 |
| 无面板时仍有 CPU 占用 | 只应在 running 空闲 1–3%；检查是否有残留 viewer（关闭页面/重启 DSH）；`phone_status` 看状态 |
| 内存占用约 2GB | redroid 容器/emulator 的固有开销；paused 时 redroid 内存保留但 CPU 归零 |

## 7. 已知未实现 / 未验证

- `cpuPct/memPct` 未实现，不要据此判断负载。
- redroid（真实 Docker）、emulator（真实二进制/AVD）、attach（真实 adbd）、scrcpy 视频流、审批 UI、真实浏览器渲染：本机均**未端到端验证**，只有单测/静态验证。
- 浏览器对 WebCodecs `avc.format='annexb'` + in-band SPS/PPS 的接受度未在真实页面验证；解码失败会自动回退软解。
- 镜像下载 scrcpy-server 的可用性未逐个验证；优先官方 URL。
