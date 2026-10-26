# 运行时与 ADB 层实现说明（#3）

> 需求原文见 [SPEC.md](./SPEC.md) §3.1–§3.5；冻结接口以 [architecture.md](./architecture.md) §3
> 与 [calibration.md](./calibration.md) 的源码校准为准（早期协作简报不在仓库内）。
> 本文记录**实现方式、取舍、与文档的偏差、以及本机未验证项**。
> issue #38 起，安装指引的「可复制命令」统一由 `src/runtime/install-guide.ts` 提供（见 §3.5）。

## 1. 范围与文件

| 文件 | 职责 |
|---|---|
| `src/adb/types.ts` | `Endpoint`、`AdbConnection`、`AdbError`/`AdbTimeoutError`、默认超时 |
| `src/adb/timing.ts` | `withTimeout` / `waitUntil`（不引入额外依赖） |
| `src/adb/credentials.ts` | Node 端 `AdbCredentialStore`：默认 `~/.android/adbkey`，缺失时生成 RSA-2048 → PKCS#8 DER（0600） |
| `src/adb/tcp.ts` | TCP socket ↔ Tango `AdbDaemonConnection` 的裸 ADB 包分帧 |
| `src/adb/transport.ts` | `connect` / `shell` / `shellRaw` / `push` / 幂等 `close` / `disconnected` |
| `src/adb/device.ts` | `AdbDevice`：screenshot / tap / swipe / key / appLaunch / dumpUi / shell |
| `src/runtime/types.ts` | `RuntimeAdapter` 等冻结类型 + 配置子结构 + `CommandRunner`/`RuntimeEnvironment` 注入点 |
| `src/runtime/command.ts` | `child_process` 命令执行器（docker / emulator） |
| `src/runtime/probe.ts` | 平台、`docker`、`/dev/binder`、`/dev/kvm`、emulator 候选路径、端口连通性探测 |
| `src/runtime/detect.ts` | SPEC §3.1 决策树 + 适配器工厂（安装指引委托 install-guide.ts） |
| `src/runtime/install-guide.ts` | **安装命令单一数据源**（#38）：平台命令构建器 + 文本/hints 渲染 + onboarding 载荷 |
| `src/runtime/attach.ts` / `emulator.ts` / `redroid.ts` | 三适配器 |
| `src/phone/idle.ts` | idle(20min，默认) / paused(30min) 计时器（可注入时钟） |
| `src/phone/state.ts` | `PhoneLifecycle` 状态机：懒启动、single-flight、booting 等待、唤醒、断连 |
| `tests/fake-adb/*` | 假 adbd TCP 服务器（ADB 协议子集）/ 假 AdbConnection / 假命令执行器与环境 / 手动时钟 |
| `tests/runtime/*` | transport / device / detect / adapters / state 单测 |

## 2. ADB 通道（纯 TS 直连，无 adb 二进制）

- 连接流程：`net.connect(host, port)` → 裸 socket 用 `StructDeserializeStream(AdbPacket)` 做变长分帧
  → `AdbDaemonTransport.authenticate({serial, connection, credentialStore})` → `new Adb(transport)`。
- 协议细节（本机库源码 `@yume-chan/adb@2.6.4` 核对）：adbd 的 TCP 通道是裸 ADB 包流，
  不是 adb server 的 `OKAY`+`长度` 帧；delayed-ack 由 banner 的 `features` 协商。
  假服务器若回 OKAY 不带 ack payload，必须逐包 ack，否则 Tango 的写流控会挂住（测试已覆盖）。
- **shell 命令走 `noneProtocol.spawn([rawCommand])`**（服务串 `exec:<raw>`）。注意：
  `spawn('shell:'+cmd)` 会被库拼成 `exec:shell:<cmd>` 从而在设备上执行失败——以源码为准，
  architecture §3.2 该行的写法不采用（此处记录偏差）。
- 超时：connect/handshake 共用 `timeoutMs`（默认 8s，可配）；shell 默认 20s；push 默认 60s。
  超时后主动销毁 socket，错误归一为 `AdbTimeoutError`。
- `push` 走 sync v1（`SEND`/`DATA`/`DONE` + `OKAY`），只支持绝对路径；用于 scrcpy-server jar。
- 中文文本注入**不在 ADB 层**：`input text` 仅 ASCII，必须走 stream 层 scrcpy `INJECT_TEXT`。
- 认证：默认复用 `~/.android/adbkey`（与本机 adb 相同的私钥，设备若已授权可直接连）；
  不存在则首次生成并落盘，设备侧需用户确认授权。

## 3. 运行时决策树与适配器

决策树严格按 SPEC §3.1（禁止跳步），每条候选都写入原因链 `steps`：

1. `docker` 可用 **且** `platform === linux` **且** `/dev/binder` 存在 → **redroid**
2. emulator 可执行文件存在 **且** 硬件虚拟化可用（Linux `/dev/kvm`；macOS Hypervisor.framework；
   Windows 用 `emulator -accel-check` 判断 WHPX）→ **emulator**
3. `attach.endpoint` 已填 **或** `userHint` 非空（待宿主接入流程解析）→ **attach**
4. 全失败 → 抛 `RuntimeUnavailableError(kind, hints[])`；`hints` = 各步原因 + **可复制命令清单**
   （来自 §3.5 的单一数据源），`phone_status` / 9 个工具 / `GET /status` 都直接展示

`runtime: redroid|emulator|attach` 显式配置时跳过决策树（不跳步的例外，见 SPEC §3.1）。

适配器语义（三者端口都是确定性 `127.0.0.1:5555`，可配）：

| 适配器 | ensureRunning | pause | resume | stop |
|---|---|---|---|---|
| redroid | `docker inspect` → `docker run -d --privileged --memory --cpus -p 127.0.0.1:5555:5555` / `start` / `unpause`，再等端口 | `docker pause`（内存保留） | `docker unpause`/`start` | `docker stop -t 10`（保留容器） |
| emulator | 解析 AVD（配置 → `-list-avds` 第一个 → `avdmanager create`）→ `spawnDetached emulator -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -port 5554 [-skin WxH]`，等端口（默认 120s） | SIGTERM 让 emulator 退出并存 quick-boot 快照 | 带 `-snapshot default_boot` 重新拉起 | SIGTERM（10s 后 SIGKILL） |
| attach | **只做端口连通校验，不启动任何外部进程** | no-op（不是插件资源） | 重新校验端口 | no-op（只由 service 断开连接，实例不动） |

端口/容器名等默认值：`DEFAULT_RUBUNTIME_OPTIONS`（`src/runtime/types.ts`）。

### 3.1 探测缓存与失效（Host 侧，issue #36）

runtime 层本身**无状态**：`detectRuntime` / `resolveRuntime` 每次调用都重新探测、不缓存。
缓存由 Host 的 `PhoneService` 负责（`src/phone/service.ts`），语义：

- 成功 `RuntimeHandle` 缓存，status/工具复用；
- **失败不永久缓存**：错误保留 30s（`RUNTIME_PROBE_RETRY_MS`）最短重探间隔，窗口后下一次
  status/工具调用重新探测 → 用户装好 emulator/AVD 或启动 Docker 后**无需重载插件**；
- `runtime` 配置或 `onboarding.status/choice` 变化立即失效（volatile 热更新）；
- adapter 不可用（`status()` 报 `running=false && paused=false` 且生命周期 stopped）、
  ADB 断连、`start`/`resume` 失败 → 丢弃 handle，下一次调用重探；
- 生命周期状态事件只广播状态，不触发探测（防探测风暴）。

因此 runtime 适配器实现不需要也不应该自己缓存探测结果；重复探测的成本由 Host 的
30s 防抖与配置指纹控制。

### 3.5 安装命令单一数据源（issue #38）

真实使用反馈：只给官网链接不够，用户需要「装什么、跑什么命令」。现在
`src/runtime/install-guide.ts` 是唯一事实来源，三处消费同一份数据，避免文案漂移：

| 消费方 | 入口 |
|---|---|
| detect → `RuntimeUnavailableError.hints` | `installGuideHints(platform)`：每行一条可复制命令；`phone_status`、9 个工具、`GET /status` 直接展示 |
| host onboarding `onboarding.install` | `createOnboardingInstallPayload()`（形状不变：`emulator{commands,size}` / `redroid{commands}` / `attach{hint}`） |
| 客户端引导卡片 | `ONBOARDING_INSTALL_COMMANDS` |

命令覆盖（Linux 示例；windows/macos 的路径与端口探测命令不同）：

    # emulator
    sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"
    avdmanager create avd -n dsh-phone-avd -k "system-images;android-34;google_apis;x86_64"
    emulator -avd dsh-phone-avd -no-window
    # 附 /dev/kvm（Linux）/ WHPX（Windows）/ Hypervisor.framework（macOS）提示与 sdkmanager 绝对路径

    # redroid（Linux）
    sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
    ls -l /dev/binder
    docker info | head -5
    docker run -d --name dsh-phone-redroid --restart=no --privileged --memory 2g --cpus 2 -v /lib/modules:/lib/modules:ro -p 127.0.0.1:5555:5555 redroid/redroid:14-latest
    # 镜像/内存/vCPU/端口从 DEFAULT_RUNTIME_OPTIONS 派生，与 RedroidRuntime 实际参数一致

    # attach：端口探测（按平台）
    ss -ltn | grep -E ':(5555|62001|16384|16416|21503)$'   # Linux；Windows 用 Test-NetConnection，macOS 用 lsof
    nc -z 127.0.0.1 5555 && echo open
    # 再在「设置 → 手机 → attach.endpoint」填 127.0.0.1:<port>

    # scrcpy-server（视频流；#37 合并后会按需自动下载，可选手工）
    node scripts/fetch-scrcpy-server.mjs

约束：插件**只展示命令、绝不执行**（SPEC §6.4）；命令不带 `$` 提示符，便于整行复制；
非 Linux 平台不展示 `docker run`（redroid 仅给 WSL2 进阶说明，避免误导）。


## 4. 生命周期状态机

- 状态：`stopped → booting → running → paused → stopped`；`booting` 是可观测中间态，
  `status().bootMs` 在 booting 时是已耗时、之后是最近一次启动耗时。
- **single-flight**：并发 `ensureRunning()` 复用同一个 in-flight promise；booting 期间的调用等待它。
- **idle → paused**（默认 20min，#67）：任意交互（`touch()`，即工具调用/面板输入/面板可见）重置计时；
  观看视频期间 viewer 每 60s 心跳 touch，不会被 idle 暂停；
  **paused → stopped**（默认 30min）。
- `touch()` 在 paused 时默认顺手唤醒（`{wake:false}` 可只重置不唤醒）。
- 断连：`notifyDisconnected(reason)` → 立即 `stopped` + `lastError`（指数退避重连由 service 层做），
  之后 `ensureRunning()` 会重新走 adapter + ADB。
- 暂停失败不改变状态、重排 idle 稍后重试；启动/唤醒失败回到原状态并把错误抛给调用方。
- 时钟可注入（`Clock`），单测用 `ManualClock` 验证 5min/30min，不真等。


### 4.3 emulator 启动性能与 quick-boot（issue #67）

实测（本机 Debian 13 / 16 vCPU / KVM / emulator 37.2.12 / Android 14 google_apis x86_64，
独立 AVD + 端口 5556，不干扰用户的 5554 实例；2 轮取中位数）：

| 场景 | adbd 端口就绪 | boot_completed(+bootanim/pm) | 首帧截图 | 进程启动→首帧 |
|---|---|---|---|---|
| 冷启动（有数据、无快照） | ~1.0s | ~33s | ~6.3s | ~40s |
| 快照启动（quick-boot） | ~1.5s | ~13.5s | ~1.0s | **~15s** |
| 暂停恢复（SIGTERM→快照加载） | ~0.9s | ~16.4s | ~2.6s | **~19s** |
| 首次冷启动（全新 AVD 首 boot） | ~0.4s | ~95s | — | ~100s |

结论：**温启动（有有效快照）从进程启动到首帧约 12–19s**，配合预热（prewarm）后用户打开面板时
实例已在 running，面板首帧只受视频流启动影响（~1–3s）。真正的冷启动（无快照/首 boot）无法压到
20s：Android 14 google_apis 首 boot 约 95s、有数据冷启动约 33s。aosp_atd（无 GApps/精简）可显著
缩短冷启动，但本机未安装该镜像（插件不代装，安装命令见 docs/install.md），因此**未实测**。

实现要点（emulator 适配器）：

1. **quick-boot 快照**
   - 启动始终带 `-snapshot default_boot`，**不传** `-no-snapshot-save`；
   - 冷启动成功后通过 emulator console（`avd snapshot save default_boot`，token 读
     `~/.emulator_console_auth_token`）主动保存一次，然后轮询 `snapshot.pb` 完整性；
   - 启动前自检快照：`snapshot.pb` < 1KB 或缺少 ram 文件 → 判为损坏（旧实现 pause 10s SIGKILL 截断），
     **删除快照目录回退冷启动**，避免 `Failed to load snapshot` 卡死；
   - pause/stop：先 console 保存 + 校验，再 SIGTERM，最多等 **120s**（旧的 10s 会截断快照写入）。
2. **同 AVD 复用（adopt）**：启动前扫描 `ps` 里同 AVD 的 qemu 进程；端口可达 → 直接复用
   （不 spawn 第二实例，避免 `multi-instance FATAL`）；端口暂不可达 → 明确报错而非再开一台。
   adopt 的用户实例：pause/stop/cancelStart 都不会杀掉它（只断开）。
3. **就绪判定**：ADB 端口连上只是 adbd 起来；真正 running 需要
   `sys.boot_completed=1` + `init.svc.bootanim=stopped` + `pm path android` 可用
   （`PhoneService.waitBootCompleted`，wiring 默认开启，超时 90s）。避免黑屏期就报 running。
4. **启动日志**：`spawnDetached` 支持 `logFile`，emulator 日志落盘
   `/tmp/dsh-phone-emulator-&lt;consolePort&gt;.log`；进程早退时把日志尾部（含 FATAL）放进错误信息，
   不再 `stdio:'ignore'` 盲等 120s。
5. **参数**：`-no-boot-anim/-no-audio/-no-window/-no-metrics`、`-gp u auto`（有 `/dev/dri` 用
   `angle_indirect`，否则 `swiftshader_indirect`）、`-memory 2048 -cores 4`、
   `-camera-back/-camera-front none`；新建 AVD 用 `-d medium_phone`；
   **只有用户显式改过 `emulator.resolution`（≠ 默认 720x1280）才传 `-skin`**，
   避免把 medium_phone 的 density/skin 覆盖成 720dp 逻辑宽度。
6. **idle/观看**：默认 idle 从 5min 调到 **20min**（暂停恢复也要 10–20s，5min 过于频繁）；
   视频流有观众时按 30s 节流上报交互（`PhoneService.#markViewerActive`），不会在观看中 pause。
7. **取消/孤儿**：boot 超时或启动失败时 `RuntimeAdapter.cancelStart()` 清理自己 spawn 的实例
   （先保存快照再 SIGTERM），避免 boot 超时后留下孤儿 emulator 占着 AVD/端口。
8. **测量脚本**：`node scripts/verify/measure-boot.mjs --repeat 2`，只使用 ≥5556 的独立端口
   （启动前 bind 探测、就绪用 connect 探测，避免抢端口），输出冷启动/快照启动/暂停恢复/首帧的
   JSON + Markdown 表；完整实测记录见 docs/verification.md。

未验证：
- aosp_atd 镜像未安装，未做实测对比（仅说明为可选快照镜像）；
- Windows/macOS 的 quick-boot/console 保存未实测；
- snapshots 文件格式按 emulator 37 目录结构（snapshot.pb + ram/img）自检，旧版本 emulator 可能不同。

### 4.2 emulator 健壮性（issue #56）

| 项 | 实现 |
|---|---|
| avdmanager 多候选 | <BT>probe.findAvdManagerPath<BT>：<BT><SDK>/cmdline-tools/latest/bin<BT> → <BT>cmdline-tools/<各版本>/bin<BT>（readdir 展开、优先新版本）→ <BT><SDK>/tools/bin<BT> → <BT>ANDROID_HOME/ANDROID_SDK_ROOT<BT> → PATH（<BT>which/where avdmanager<BT>）；Windows 用 <BT>avdmanager.bat<BT> |
| AVD 安全化 | 显式 <BT>emulator.avdName<BT> 必须存在于 <BT>emulator -list-avds<BT>，否则**明确报错并列出已有 AVD**（不再静默取第一个）；自动模式只选 <BT>dsh-phone-*<BT> 前缀的 AVD，没有则用 avdmanager 创建 <BT>dsh-phone-avd<BT>；绝不劫持用户自己的 AVD |
| 空闲端口 | 默认 console 5554 / adb 5555 被其它模拟器占用时，向上找空闲偶数 console（5556/5558…，上限 5584），<BT>adb = console + 1<BT>；实际端口写入 <BT>RuntimeStatus.endpoint<BT> 与 <BT>ensureRunning()<BT> 返回值（ADB connect 用实际端口）；显式 <BT>emulator.port<BT> 被占用则明确报错 |
| cpuPct/memPct | 尽力而为：emulator 读 Linux <BT>/proc/<pid>/stat、<BT>/proc/<pid>/status<BT>（CPU% 需两次采样取 delta）；redroid 用 <BT>docker stats --no-stream<BT>；attach 用 <BT>dumpsys cpuinfo<BT> + <BT>/proc/meminfo<BT>（service 层 5s 缓存）；取不到就省略字段，不报错 |
| booting 进度 | <BT>RuntimeAdapter.ensureRunning<BT> 的 onProgress 第二参是 <BT>BootPhase<BT>（launching / waiting-adbd / connecting-adb / ready）；<BT>/status<BT> 在 booting 时返回 <BT>phase<BT>（可选字段，向后兼容；客户端可继续用 bootMs） |

取舍：
- 端口只探测**是否有人在听**（<BT>RuntimeEnvironment.isPortBusy<BT>），与“adbd 就绪”的 <BT>waitForPort<BT> 语义分开，避免把就绪端口误判为占用。
- AVD 自动创建仍是“用户显式接受安装/首次启动”后的行为，插件不安装 system image（创建失败会给安装指引）。
- cpuPct/memPct 是展示性数据：采样失败/平台不支持时静默省略，绝不阻断 status 或工具调用。

未验证（本机无 emulator 二进制/AVD、无 Docker）：
- avdmanager 版本目录展开、真实 AVD 创建与 <BT>-list-avds<BT> 解析未在真机验证；
- 端口自愈（5554 被占用→5556）未在真的双 emulator 场景验证；
- /proc CPU delta 与 <BT>docker stats<BT> 数值未与本机真实进程/容器对账。

### 4.1 冷启动窗口内的重试（issue #44）

真实 emulator 冷启动验收发现：adbd 端口很快可连，但系统尚未 `boot_completed`，
第一次 ADB 握手 8s 超时、随后截图返回异常输出，等约 100s 后才能成功——旧实现直接抛错，用户需手工重试。
现在分三层处理：

1. **连接/握手重试**（`src/phone/boot-retry.ts` + `PhoneService.#connectDuringBoot`）：
   boot 窗口内按 **500ms → 1s → 2s → 4s → 8s（封顶）** 退避重试 ADB connect，预算
   `bootTimeoutMs - 20s`（默认 120s − 20s），给每次握手自身（最长 8s）留余量；
   耗尽后才抛错，错误文案带「已尝试 N 次 / 约 Xs / 最后一次原因」并标 `retryable`。
   - 只重试暂时性错误（`AdbError` 全部 / `retryable:true` / timeout/connect/closed/device-not-ready）；
     普通配置错误立即失败（不把真错误拖 120s）。
   - <BTruntime 不恢复 / adapter 启动失败` 不在此重试范围（那是决策树/安装问题，仍走 `E_RUNTIME_UNAVAILABLE`）。
2. **截图重试**（`AdbDevice.screenshot`）：默认 3 次尝试，失败后按 500ms、1000ms 退避重试；
   空输出 / 非法 base64 / 非 PNG 一律归类为 `E_DEVICE_NOT_READY`（`AdbError.code='device-not-ready'`，
   `retryable=true`），不再报「base64 非法」。耗尽后错误文案为「设备尚未就绪：连续 3 次截图失败…」。
   - HTTP `GET /screenshot` 对 `device-not-ready` 返回 **200 + E_BOOTING（retryable）**；
     工具层 `failureFrom` 同样映射为 `E_BOOTING`（与 booting 中间态一致，Agent 等待后重试）。
3. **lastError 清理**：`PhoneLifecycle` 在 boot 成功进入 running 时显式清空 `lastError`；
   `PhoneService.status()` 在 running 时不再回退展示历史探测/启动错误（只保留当前状态相关错误）。

取舍：没有采用「轮询 `sys.boot_completed` 阻塞启动」的方案——它会把 booting 中间态变成长时间无反馈，
且对 attach/真机（部分设备该属性异常）不友好；退避重试 + 截图重试在真实设备上同样能自愈，且状态仍可观测。


宿主（`src/phone/service.ts`，task-4）只需提供 `LifecycleHooks`：
`start = adapter.ensureRunning + adb.connect + AdbDevice 就绪`，`pause/resume/stop` 调 adapter 并管理连接。

## 5. 测试与自检

```sh
npx tsc --noEmit                 # 通过
node --test                      # 306 通过 + 5 跳过（共 311）：transport/device/detect/adapters/state
                                 # + install-guide 20 例（命令快照 + 各平台 hints + 防漂移）
                                 # + boot-retry 11 例（退避序列、握手重试、lastError 清理、截图重试）
                                 # + 既有 host/stream/client 用例
node scripts/check-file-lines.mjs
```

测试不依赖真机：`tests/fake-adb/server.ts` 在 localhost 实现 adbd 协议子集
（CNXN、AUTH token/signature、OPEN、WRTE、CLSE、sync v1 SEND），端到端验证 `transport.ts`；
device/detect/adapters/state 用注入的假对象，不发任何真实命令。
`tests/runtime/install-guide.test.ts` 用**命令快照**锁文案：每个平台的 hints 必须包含
sdkmanager / avdmanager / docker run / attach 端口探测 / scrcpy 下载命令，且 onboarding 载荷与
客户端卡片命令必须能在安装指引文本中找到（零漂移守卫）。

## 6. 本机未验证项（重要）

| 项 | 现状 | 风险 |
|---|---|---|
| redroid（真实 Docker） | 本机无 Docker，只有假 CLI 单测 | `docker run` 参数（binder 设备、`/lib/modules` 挂载、端口映射）未在真 redroid 验证 |
| emulator（真实二进制） | 本机 SDK 无 emulator 包、无 AVD | 启动参数、端口就绪判定、**quick-boot 快照语义**（SIGTERM 存快照 + `-snapshot default_boot` 恢复）未实测 |
| `avdmanager create` | 未实测 | system image 未安装时的错误文案已覆盖，但真正创建 AVD 未验证 |
| attach（真实实例） | 本机 waydroid adb 端口不可达 | 仅假环境单测；真实 adbd 的 AUTH 授权流程未端到端验证 |
| Windows WHPX 检测 | 未在 Windows 验证 | `emulator -accel-check` 输出匹配是启发式 |
| 真实 Android 设备的 `screencap`/`uiautomator` | 未实测 | 命令与临时文件清理逻辑按 toybox 行为编写，假连接覆盖了流程 |
| 安装指引中的 sdkmanager/avdmanager/emulator/docker run 命令文本 | 未在本机逐条执行 | 按官方用法与适配器参数生成；本机无 emulator/Docker。命令快照测试只保证文案不漂移，不代表已跑通 |
| 冷启动重试的真实时序 | 未在真 emulator 复测（本机无 AVD） | 退避序列/重试次数/截图重试用假实现覆盖；真实 boot_completed 时间因机器而异，120s 窗口可配置 |

## 7. 设计取舍 / 与文档的偏差

1. **shell 服务串**：`exec:<raw>`（`spawn([cmd])`），不是 architecture §3.2 的 `spawn('shell:'+cmd)`；
   原因见 §2（会被库再拼一层 `exec:` 而失败）。Android 7+ 均支持 `cmd` 特性；
   老设备（<7）需要改用 pty，暂不支持。
2. **attach 的 pause/resume/stop**：适配器只维护“端口是否可达”，不碰实例；连接生命周期归 service 层，
   这样 attach 永远不会误停用户自己的模拟器/真机（SPEC §3.5）。
3. **`RuntimeUnavailableError`**：签名对齐 architecture §3.1 `(kind, hints, cause?)`；
   额外第 4 参携带 `platform/steps` 供诊断，宿主只依赖 `kind/hints`。
4. **`notifyDisconnected` 直接回 stopped**：SSPEC 要求“重连指数退避 3 次后仍失败才 stopped”，
   重试属 service 层职责；状态机只接收最终结论，避免状态机里藏网络重试。
5. **screenshot 用 base64 取回**（INTERFACES §2 指定），不用 sync pull：少开一条 sync 通道，
   代价是设备端多一次 base64 编码（720p PNG 约 0.3–1ms 量级）。
6. **`AdbConnection` 额外暴露 `disconnected`/`serial`**：INTERFACES 只要求 `raw`，这两个是 service 层
   检测断连与日志所需的最小增量（不破坏原语义）。
7. **安装命令单一数据源（#38）**：命令构建器放在 `src/runtime/install-guide.ts`（纯数据、无 Node 依赖），
   detect hints / host onboarding 载荷 / client 卡片共用；onboarding 载荷形状保持向后兼容
   （`emulator.size` 仍是 `~1.7GB`）。
8. **非 Linux 的 redroid**：只给「WSL2 进阶、默认不推荐」说明，不给 `docker run`，避免用户误以为
   Windows/macOS 可以直接跑 redroid。
9. **冷启动重试用固定预算而非轮询 boot_completed**（#44）：见 §4.1；sleep 可注入，单测不真的等。
10. **截图耗尽后的错误码**：新增 `AdbError.code='device-not-ready'`（可重试），HTTP/工具层映射为
   `E_BOOTING`，不新造协议错误码（复用 docs/protocol.md §3 既有语义）。

## 8. 给 Host 层的最小接入示例

```ts
const deps = { env: createSystemEnvironment(), runner: createCommandRunner() }
const { adapter, detection } = await resolveRuntime(options, deps) // 全失败抛 RuntimeUnavailableError
const endpoint = await adapter.ensureRunning((msg) => ctx.logger.info(msg))
const connection = await connect(endpoint, { timeoutMs: 8_000 })
const device = new AdbDevice(connection)
const lifecycle = new PhoneLifecycle({ start, pause, resume, stop })
```

## 9. 后续 TODO（不属于 #3）

- 老设备（无 `cmd` 特性）的 shell 回退路径（pty）。
- emulator 快照实测与“资源紧张”主动降级（SPEC §3.4 括号里的可选策略）。
- scrcpy-server 的 push（`AdbConnection.push` 已就绪，见 task-5）。

- scrcpy-server 的 push（`AdbConnection.push` 已就绪，见 task-5）。
- #37 合并后可从安装指引里删掉「手工下载 scrcpy-server」一节（改为纯自动），
  同步修改本文件与 `install-guide.ts` 的 SCRCPY_SECTION。


## 5. 生命周期控制与外部 kill 兜底（issue #83）

### 5.1 所有权

`RuntimeStatus` 增加 `owned` / `adopted`（两者互斥）：

| 适配器 | owned | adopted | isAlive() |
|---|---|---|---|
| emulator（插件 spawn） | true | false | pid 存活（booting 期端口未起也算活） |
| emulator / attach（复用用户实例） | false | true | 端口/adb 连通性（不碰用户进程） |
| redroid | true | false | docker 容器 running/paused |

`PhoneStatus` 同步暴露 `owned/adopted/pid`（host 的 `GET /status`、`GET /api/runtime` 使用）。

### 5.2 PhoneService 动作

`start()` / `stop({force?})` / `restart()` / `isAlive()`，全部经 `ActionQueue` 单一互斥：

- 同动作并发 → 复用同一个 in-flight promise；不同动作 → 串行排队；
- 每动作超时（默认 180s，`actionTimeoutMs` 可注入），超时抛 `RuntimeError`；
- **owned stop** → `lifecycle.stopNow()` → `hooks.stop` → `adapter.stop()`（保存 quick-boot 快照并等退出）；
- **adopted stop** → 只关流 + 断开 ADB，`halt()` 置 stopped，lastError「已断开连接（实例由用户启动，未关闭）」；
- **booting stop** → `adapter.cancelStart()`（最多等 15s）打断启动，立即 stopped（不泄漏进程）；
- **restart** = `stop({force:true})` → `ensureRunning()`，返回最终状态。

### 5.3 看门狗（外部 kill 兜底）

running / booting 时每 **2s**（`watchdogIntervalMs` 可注入 `setInterval` 供单测）调用一次
`adapter.isAlive()`；false → `cancelStart + closeSessions + disconnectAdb + lifecycle.halt`，
写 lastError「实例已被外部关闭（pid 消失/端口关闭）」并广播状态。用户 <B>kill -9` emulator 后
面板 ≤2–3s 即可看到「已停止」并提供「启动手机」。stop/restart 动作进行中跳过看门狗，避免误判。

### 5.4 dispose（插件卸载/重载）

`dispose()` 有 **硬预算（默认 5s，`disposeBudgetMs` 可注入）**：adapter.status / stop /
流关闭 / `lifecycle.dispose`（它会 await boot inflight，最长可到 100s+）全部 `Promise.race`
剩余预算；超预算放弃等待并完成卸载，解决「插件关不掉」：

- owned：先尝试 `stopNow('插件卸载：已停止手机实例')`（保存快照），预算内等不到就放弃，不留启动阻塞；
- adopted：只关流 + 断 ADB，绝不动用户实例；
- 最后 `lifecycle.dispose()` 同样受预算约束。

### 5.5 测试

`tests/runtime/lifecycle-control.test.ts`：外部 kill → stopped+lastError；booting 中消失；
owned/adopted stop 差异；booting stop 打断（cancelStart）；restart 序列；并发 stop 合并；
动作超时；boot 挂起时 dispose ≤ 预算返回；dispose owned/adopted 差异。
