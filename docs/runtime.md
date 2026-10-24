# 运行时与 ADB 层实现说明（#3）

> 需求原文见 [SPEC.md](./SPEC.md) §3.1–§3.5；冻结接口以 [architecture.md](./architecture.md) §3
> 与 [calibration.md](./calibration.md) 的源码校准为准（早期协作简报不在仓库内）。
> 本文记录**实现方式、取舍、与文档的偏差、以及本机未验证项**。

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
| `src/runtime/detect.ts` | SPEC §3.1 决策树 + 平台安装指引 + 适配器工厂 |
| `src/runtime/attach.ts` / `emulator.ts` / `redroid.ts` | 三适配器 |
| `src/phone/idle.ts` | idle(5min) / paused(30min) 计时器（可注入时钟） |
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
4. 全失败 → 抛 `RuntimeUnavailableError(kind, hints[])`，`hints` 含各步原因 + 平台安装指引

`runtime: redroid|emulator|attach` 显式配置时跳过决策树（不跳步的例外，见 SPEC §3.1）。

适配器语义（三者端口都是确定性 `127.0.0.1:5555`，可配）：

| 适配器 | ensureRunning | pause | resume | stop |
|---|---|---|---|---|
| redroid | `docker inspect` → `docker run -d --privileged --memory --cpus -p 127.0.0.1:5555:5555` / `start` / `unpause`，再等端口 | `docker pause`（内存保留） | `docker unpause`/`start` | `docker stop -t 10`（保留容器） |
| emulator | 解析 AVD（配置 → `-list-avds` 第一个 → `avdmanager create`）→ `spawnDetached emulator -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -port 5554 [-skin WxH]`，等端口（默认 120s） | SIGTERM 让 emulator 退出并存 quick-boot 快照 | 带 `-snapshot default_boot` 重新拉起 | SIGTERM（10s 后 SIGKILL） |
| attach | **只做端口连通校验，不启动任何外部进程** | no-op（不是插件资源） | 重新校验端口 | no-op（只由 service 断开连接，实例不动） |

端口/容器名等默认值：`DEFAULT_RUBUNTIME_OPTIONS`（`src/runtime/types.ts`）。

## 4. 生命周期状态机

- 状态：`stopped → booting → running → paused → stopped`；`booting` 是可观测中间态，
  `status().bootMs` 在 booting 时是已耗时、之后是最近一次启动耗时。
- **single-flight**：并发 `ensureRunning()` 复用同一个 in-flight promise；booting 期间的调用等待它。
- **idle → paused**（默认 5min）：任意交互（`touch()`，即工具调用/面板输入/面板可见）重置计时；
  **paused → stopped**（默认 30min）。
- `touch()` 在 paused 时默认顺手唤醒（`{wake:false}` 可只重置不唤醒）。
- 断连：`notifyDisconnected(reason)` → 立即 `stopped` + `lastError`（指数退避重连由 service 层做），
  之后 `ensureRunning()` 会重新走 adapter + ADB。
- 暂停失败不改变状态、重排 idle 稍后重试；启动/唤醒失败回到原状态并把错误抛给调用方。
- 时钟可注入（`Clock`），单测用 `ManualClock` 验证 5min/30min，不真等。

宿主（`src/phone/service.ts`，task-4）只需提供 `LifecycleHooks`：
`start = adapter.ensureRunning + adb.connect + AdbDevice 就绪`，`pause/resume/stop` 调 adapter 并管理连接。

## 5. 测试与自检

```sh
npx tsc --noEmit                 # 通过
node --test                      # 56 例全绿（transport 9 / device 9 / detect 10 / adapters 15 / state 13）
node scripts/check-file-lines.mjs
```

测试不依赖真机：`tests/fake-adb/server.ts` 在 localhost 实现 adbd 协议子集
（CNXN、AUTH token/signature、OPEN、WRTE、CLSE、sync v1 SEND），端到端验证 `transport.ts`；
device/detect/adapters/state 用注入的假对象，不发任何真实命令。

## 6. 本机未验证项（重要）

| 项 | 现状 | 风险 |
|---|---|---|
| redroid（真实 Docker） | 本机无 Docker，只有假 CLI 单测 | `docker run` 参数（binder 设备、`/lib/modules` 挂载、端口映射）未在真 redroid 验证 |
| emulator（真实二进制） | 本机 SDK 无 emulator 包、无 AVD | 启动参数、端口就绪判定、**quick-boot 快照语义**（SIGTERM 存快照 + `-snapshot default_boot` 恢复）未实测 |
| `avdmanager create` | 未实测 | system image 未安装时的错误文案已覆盖，但真正创建 AVD 未验证 |
| attach（真实实例） | 本机 waydroid adb 端口不可达 | 仅假环境单测；真实 adbd 的 AUTH 授权流程未端到端验证 |
| Windows WHPX 检测 | 未在 Windows 验证 | `emulator -accel-check` 输出匹配是启发式 |
| 真实 Android 设备的 `screencap`/`uiautomator` | 未实测 | 命令与临时文件清理逻辑按 toybox 行为编写，假连接覆盖了流程 |

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
