/**
 * PhoneService：Host 侧编排（INTERFACES §3 / architecture §3.3）。
 *
 * - 生命周期状态机由 runtime 的 `PhoneLifecycle`（src/phone/state.ts）提供，经
 *   `createLifecycle` 注入；本类只编排 runtime/adb/stream，不复制状态机实现；
 * - `ensureRunning` 单飞（in-flight promise 复用）；已在 booting 时
 *   `ensureInteractive` 立即返回可重试中间态（工具层转 E_BOOTING，不抛错）；
 * - screenshot/设备命令串行队列（同一时刻最多 1 个 screencap）；
 * - startStream 引用计数；inputText/touch 走 scrcpy 控制通道（无视频时按需开
 *   control-only 会话），**绝不使用 shell input text**（SPEC §4）；
 * - 所有配置实时从 `deps.config()` 读，不缓存快照（architecture §6）。
 */
import { AdbError } from '../adb/types.ts'
import type { OnboardingChoice, OnboardingStatus } from '../config/onboarding.ts'
import { RuntimeError } from '../runtime/types.ts'
import type {
  BootPhase,
  Endpoint,
  PhoneState,
  ProcessUsage,
  RuntimeAdapter,
  RuntimeKind,
  RuntimeStatus,
} from '../runtime/types.ts'
import {
  DEFAULT_BOOT_TIMEOUT_MS,
  bootRetryDelays,
  bootRetryExhaustedMessage,
  isRetryableBootError,
} from './boot-retry.ts'
import { withTimeout } from '../adb/timing.ts'
import type {
  InteractiveReadiness,
  PhoneOperations,
  PhoneStatus,
  Platform,
  StopOptions,
  VerifyResult,
} from './contracts.ts'
import {
  ATTACH_CPU_COMMAND,
  ATTACH_MEM_COMMAND,
  usageFromAttachOutputs,
} from './usage.ts'

import type {
  AdbConnectionLike,
  CreateLifecycle,
  DeviceOps,
  LifecycleHooksLike,
  LifecycleLike,
  LifecycleStatusLike,
  PhoneServiceDeps,
  RuntimeHandle,
  ServiceConfig,
  StartStreamSession,
  StreamSession,
  StreamSessionOptions,
  StreamSink,
} from './service-types.ts'

export type {
  AdbConnectionLike,
  CreateLifecycle,
  DeviceOps,
  LifecycleHooksLike,
  LifecycleLike,
  LifecycleStatusLike,
  PhoneServiceDeps,
  RuntimeHandle,
  ServiceConfig,
  StartStreamSession,
  StreamSession,
  StreamSessionOptions,
  StreamSink,
} from './service-types.ts'

type ActionName = 'start' | 'stop' | 'restart'

const DEFAULT_STREAM_GRACE_MS = 5_000
/** viewer 存活期间的心跳（issue #73）：周期性 touch，idle 不应在有人观看时休眠。 */
const VIEWER_HEARTBEAT_MS = 60_000
/** attach 资源占用采样缓存（issue #56，避免 /status 轮询频繁 shell）。 */
const USAGE_CACHE_MS = 5_000
/**
 * boot 重试预算（issue #44）：给每次 connect 自身（最长 8s）留出余量，
 * 保证“延迟累计 + 最后一次尝试”不会先撞上 lifecycle 的 120s boot 超时。
 */
const BOOT_RETRY_BUDGET_MS = DEFAULT_BOOT_TIMEOUT_MS - 20_000

import {
  RUNTIME_PROBE_RETRY_MS,
  parseEndpoint,
  runtimeConfigFingerprint,
  toError,
} from './service-helpers.ts'

export { RUNTIME_PROBE_RETRY_MS, runtimeConfigFingerprint } from './service-helpers.ts'

export class PhoneService implements PhoneOperations {
  readonly #deps: PhoneServiceDeps
  readonly #lifecycle: LifecycleLike
  readonly #listeners = new Set<(status: PhoneStatus) => void>()
  #platform: Platform = 'other'
  #handle: RuntimeHandle | undefined
  #handleError: Error | undefined
  /** 失败时间戳（用于 RUNTIME_PROBE_RETRY_MS 防抖）。 */
  #handleErrorAt = 0
  #configFingerprint: string | undefined
  readonly #now: () => number
  #connection: AdbConnectionLike | undefined
  #device: DeviceOps | undefined
  #stream: StreamSession | undefined
  #control: StreamSession | undefined
  #viewers = 0
  #streamToken = 0
  #closeTimer: (() => void) | undefined
  #viewerHeartbeat: (() => void) | undefined
  #ensurePromise: Promise<void> | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #serialPending = 0
  #lastViewerTouchAt = 0
  #disposed = false
  /** booting 进度阶段（issue #56）。 */
  #bootPhase: BootPhase | undefined
  /** attach 资源占用采样缓存（issue #56）。 */
  #usage: ProcessUsage | undefined
  #usageAt = 0
  /** issue #83：看门狗与动作用状态。 */
  #watchdogStop: (() => void) | undefined
  #lastRuntimeStatus: RuntimeStatus | undefined
  #actionQueue: Promise<unknown> = Promise.resolve()
  #actionInflight: { action: ActionName; promise: Promise<PhoneStatus> } | undefined
  #actionToken = 0
  #disposing = false

  constructor(deps: PhoneServiceDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => Date.now())
    const config = deps.config()
    this.#configFingerprint = runtimeConfigFingerprint(config)
    this.#lifecycle = deps.createLifecycle(
      {
        start: () => this.#start(),
        resume: () => this.#resume(),
        pause: () => this.#pause(),
        stop: () => this.#stop(),
        onError: (error, phase) => this.#onLifecycleError(error, phase),
      },
      {
        idleTimeoutMs: config.lifecycle.idleTimeoutMs,
        pausedTimeoutMs: config.lifecycle.pausedTimeoutMs,
        bootTimeoutMs: DEFAULT_BOOT_TIMEOUT_MS,
      },
    )
    this.#lifecycle.onChange((status) => {
      this.#emit(status)
      this.#syncWatchdog(status.state)
    })
    void deps.platform().then(
      (platform) => {
        this.#platform = platform
      },
      () => undefined,
    )
  }

  /* ------------------------------- 状态与生命周期 ------------------------------- */

  async status(): Promise<PhoneStatus> {
    const handle = await this.#runtime()
    const runtimeStatus = await handle.adapter.status().catch(() => undefined)
    this.#lastRuntimeStatus = runtimeStatus
    this.#invalidateIfAdapterUnavailable(handle, runtimeStatus)
    const config = this.#deps.config()
    const lifecycle = this.#lifecycle.status
    const endpoint =
      runtimeStatus?.endpoint ??
      (config.attach.endpoint ? parseEndpoint(config.attach.endpoint) : undefined)
    const status: PhoneStatus = {
      state: lifecycle.state,
      runtime: handle.detection.kind,
      platform: handle.detection.platform,
    }
    if (endpoint) status.endpoint = endpoint
    if (runtimeStatus) {
      status.owned = runtimeStatus.owned
      status.adopted = runtimeStatus.adopted
      if (runtimeStatus.pid !== undefined) status.pid = runtimeStatus.pid
    }
    if (lifecycle.bootMs !== undefined) status.bootMs = lifecycle.bootMs
    // issue #56：booting 时给出进度阶段（可选字段，客户端可忽略）
    if (lifecycle.state === 'booting' && this.#bootPhase !== undefined) {
      status.phase = this.#bootPhase
    }
    const usage = await this.#measureUsage(handle.detection.kind, runtimeStatus)
    if (usage.cpuPct !== undefined) status.cpuPct = usage.cpuPct
    if (usage.memPct !== undefined) status.memPct = usage.memPct
    // issue #44：running 后不再展示历史启动/探测错误，避免误导；仅保留当前状态相关错误
    const lastError =
      lifecycle.state === 'running'
        ? lifecycle.lastError
        : (lifecycle.lastError ?? this.#handleError?.message)
    if (lastError) status.lastError = lastError
    return status
  }

  async ensureRunning(): Promise<void> {
    this.#assertAlive()
    // issue #70：runtime/onboarding/attach.endpoint/resolved 任一变化 → 丢弃旧 adapter+ADB，
    // 强制走启动路径（不得命中下面的 running 快路径）。
    if (this.#invalidateOnConfigChange()) {
      await this.#closeSessions()
      await this.#disconnectAdb()
      this.#lifecycle.notifyDisconnected('配置变化：重新解析运行时/端点')
      this.#emitStatus()
    }
    if (this.#lifecycle.state === 'running') {
      this.#lifecycle.touch()
      return
    }
    this.#ensurePromise ??= (async () => {
      try {
        await this.#lifecycle.ensureRunning()
        // 启动/唤醒成功：清掉此前的探测/连接错误（issue #44）
        this.#handleError = undefined
        this.#handleErrorAt = 0
        this.#lifecycle.touch()
      } finally {
        this.#ensurePromise = undefined
      }
    })()
    return this.#ensurePromise
  }

  async ensureInteractive(): Promise<InteractiveReadiness> {
    if (this.#lifecycle.state === 'booting') {
      return { state: 'booting', bootMs: this.#lifecycle.status.bootMs ?? 0 }
    }
    await this.ensureRunning()
    return { state: 'running' }
  }

  /** issue #83：显式启动（幂等；返回最终状态）。 */
  async start(): Promise<PhoneStatus> {
    return this.#runAction('start', async () => {
      await this.ensureRunning()
      return this.status()
    })
  }

  /** issue #83：停止（owned 保存快照等退出；adopted 只断开，不杀用户实例）。 */
  async stop(options: StopOptions = {}): Promise<PhoneStatus> {
    return this.#runAction('stop', async () => this.#doStop(options))
  }

  /** issue #83：重启（先停后启；返回最终状态）。 */
  async restart(): Promise<PhoneStatus> {
    return this.#runAction('restart', async () => {
      await this.#doStop({ force: true })
      await this.ensureRunning()
      return this.status()
    })
  }

  /** issue #83：实例是否还活着（看门狗/健康检查）。 */
  async isAlive(): Promise<boolean> {
    const handle = await this.#runtime().catch(() => undefined)
    if (!handle) return false
    return handle.adapter.isAlive().catch(() => false)
  }

  onStateChange(listener: (status: PhoneStatus) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /* ---------------------------------- 设备操作 --------------------------------- */

  screenshot(): Promise<Uint8Array> {
    return this.#serial(() => this.#requireDevice().screenshot())
  }

  tap(x: number, y: number): Promise<void> {
    return this.#serial(async () => {
      await this.ensureRunning()
      await this.#requireDevice().tap(x, y)
    })
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    return this.#serial(async () => {
      await this.ensureRunning()
      await this.#requireDevice().swipe(x1, y1, x2, y2, durationMs)
    })
  }

  key(name: string): Promise<void> {
    return this.#serial(async () => {
      await this.ensureRunning() // running 快路径会 touch（面板按键算交互）
      await this.#requireDevice().key(name)
    })
  }

  appLaunch(pkg: string): Promise<void> {
    return this.#serial(async () => {
      await this.ensureRunning()
      await this.#requireDevice().appLaunch(pkg)
    })
  }

  dumpUi(): Promise<string> {
    return this.#serial(async () => {
      await this.ensureRunning()
      return this.#requireDevice().dumpUi()
    })
  }

  shell(command: string): Promise<string> {
    return this.#serial(async () => {
      await this.ensureRunning()
      return this.#requireDevice().shell(command)
    })
  }

  /** 中文文本注入：scrcpy 控制通道 INJECT_TEXT（禁止 shell input text）。 */
  async inputText(text: string): Promise<void> {
    this.#lifecycle.touch() // 面板输入算交互（issue #73）
    const session = await this.#controlSession()
    await session.injectText(text)
  }

  /** scrcpy 触摸注入（与 lifecycle.touch 的 idle 唤醒信号区分，见 contracts.ts）。 */
  async touchScreen(action: 'down' | 'move' | 'up', x: number, y: number): Promise<void> {
    this.#lifecycle.touch() // 面板触摸算交互（issue #73）
    const session = await this.#controlSession()
    await session.injectTouch(action, x, y)
  }

  /* ---------------------------------- 视频流 ---------------------------------- */

  async startStream(sink: StreamSink): Promise<() => Promise<void>> {
    await this.ensureRunning()
    const config = this.#deps.config()
    // issue #73：每次视频会话一个代际；旧 viewer 的 release 不得关掉新流。
    const generation = ++this.#streamToken
    this.#cancelClose()
    this.#stopViewerHeartbeat()
    if (this.#stream) {
      const old = this.#stream
      this.#stream = undefined
      this.#viewers = 0
      await old.close().catch(() => undefined)
    }
    await this.#control?.close().catch(() => undefined)
    this.#control = undefined
    const session = await this.#deps.startStream({
      // stream 层收的是 AdbConnection 本身（内部读 adb.raw）；传 Tango Adb 会 undefined（issue #59）
      adb: this.#requireConnection(),
      video: true,
      sink,
      config: config.stream,
    })
    if (generation !== this.#streamToken) {
      await session.close().catch(() => undefined)
      return async () => undefined
    }
    this.#stream = session
    this.#viewers += 1
    this.#armViewerHeartbeat() // viewer 存活 → 周期性 touch，idle 5min 不会关流（issue #73）
    let released = false
    return async () => {
      if (released) return
      released = true
      if (generation !== this.#streamToken) return // 旧代际的 release 忽略
      this.#viewers = Math.max(0, this.#viewers - 1)
      if (this.#viewers === 0) {
        this.#stopViewerHeartbeat()
        this.#scheduleClose()
      }
    }
  }

  /* ---------------------------------- 接入验证 --------------------------------- */

  async verifyEndpoint(endpoint: string): Promise<VerifyResult> {
    const parsed = parseEndpoint(endpoint)
    if (!parsed) return { ok: false, latencyMs: 0, error: 'endpoint 必须是 host:port' }
    const startedAt = Date.now()
    let connection: AdbConnectionLike | undefined
    try {
      connection = await this.#deps.connect(parsed, { timeoutMs: 3000 })
      const banner = await this.#deps.createDevice(connection).shell('getprop ro.product.model')
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        banner: banner.trim() || undefined,
      }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: toError(error).message }
    } finally {
      if (connection) await this.#deps.disconnect(connection).catch(() => undefined)
    }
  }

  /**
   * issue #83：卸载必须“关得掉”。总预算默认 5s（可注入），任何一步（status/stop/
   * 流关闭/lifecycle.dispose 等 inflight）都不得无限等待；owned 先尝试 stop（保存快照），
   * adopted 只断开。超预算放弃等待并完成卸载。
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#disposing = true
    this.#stopWatchdog()
    this.#cancelClose()
    this.#stopViewerHeartbeat()
    const budget = this.#deps.disposeBudgetMs ?? 5000
    const deadline = this.#now() + budget
    const remaining = (): number => Math.max(1, deadline - this.#now())
    const within = async (work: Promise<unknown>): Promise<unknown> =>
      Promise.race([work.catch(() => undefined), this.#delay(remaining())])
    const status = (await within(
      Promise.race([this.#adapterStatus(), this.#delay(Math.min(1000, remaining()))]),
    )) as RuntimeStatus | undefined
    if (status?.owned === true) {
      // owned：先尝试 stop（保存快照），但只在总预算内等
      await within(this.#lifecycle.stopNow('插件卸载：已停止手机实例'))
    } else {
      await within(this.#closeSessions())
      await within(this.#disconnectAdb())
    }
    await within(this.#closeSessions())
    await within(this.#disconnectAdb())
    await within(this.#lifecycle.dispose())
    this.#stopWatchdog()
    this.#listeners.clear()
    this.#disposing = false
  }

  /* ---------------------------------- 生命周期钩子 --------------------------------- */

  async #start(): Promise<void> {
    const handle = await this.#runtime()
    this.#bootPhase = 'launching'
    const endpoint = await handle.adapter.ensureRunning((_message, phase) => {
      if (phase) this.#bootPhase = phase
    })
    await this.#connectDuringBoot(endpoint)
  }

  async #resume(): Promise<void> {
    const handle = await this.#runtime()
    this.#bootPhase = 'launching'
    await handle.adapter.resume()
    const status = await handle.adapter.status()
    const endpoint = status.endpoint ?? parseEndpoint(this.#deps.config().attach.endpoint)
    if (!endpoint) throw new Error('resume 后无法确定 attach endpoint')
    await this.#connectDuringBoot(endpoint)
  }

  async #pause(): Promise<void> {
    // issue #73：viewer 存活时不得 idle 休眠/关流。抛错让 PhoneLifecycle 保持 running 并重排 idle 计时。
    if (this.#viewers > 0) {
      this.#armViewerHeartbeat()
      throw new Error('viewer 正在观看，跳过 idle 休眠（issue #73）')
    }
    await this.#closeSessions()
    await this.#disconnectAdb()
    const handle = await this.#runtime()
    await handle.adapter.pause()
  }

  async #stop(): Promise<void> {
    await this.#closeSessions()
    await this.#disconnectAdb()
    const handle = await this.#runtime().catch(() => undefined)
    await handle?.adapter.stop().catch(() => undefined)
  }

  #onLifecycleError(error: Error, phase: string): void {
    if (phase === 'start' || phase === 'resume') {
      this.#bootPhase = undefined
      // issue #67：boot 超时/失败时清理半启动实例，避免孤儿 emulator 占着 AVD/端口
      const handle = this.#handle
      void handle?.adapter.cancelStart?.().catch(() => undefined)
      // 启动/唤醒失败：adapter 可能已不可用，丢弃 handle 让下一次调用重新探测；
      // 探测本身失败的错误由 #runtime 缓存（30s 防抖），这里不再覆盖。
      this.#dropHandle()
      void this.#disconnectAdb()
    }
    // 注意：pause/stop 失败不写入 #handleError（那是运行时探测失败缓存，issue #36/#73）——
    // viewer 存活时的 pause 否决不该污染 phone_status/探测防抖。
    this.#emitStatus()
  }

  /**
   * 冷启动窗口内建立 ADB 连接（issue #44）：adbd 端口可连但握手/执行可能失败，
   * 按 500ms→1s→2s→4s→8s 退避重试，直到成功或 boot 预算耗尽。
   */
  async #connectDuringBoot(endpoint: Endpoint): Promise<void> {
    this.#bootPhase = 'connecting-adb'
    const delays = this.#deps.bootRetryDelays?.() ?? bootRetryDelays(BOOT_RETRY_BUDGET_MS)
    let lastError: Error | undefined
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#attachAdb(endpoint)
        this.#handleError = undefined
        this.#handleErrorAt = 0
        // issue #67：adbd 可连 ≠ 系统可用；等 boot_completed + pm ready 再宣告 running
        await this.#waitDeviceReady()
        this.#bootPhase = 'ready'
        return
      } catch (error) {
        lastError = toError(error)
        const delay = delays[attempt]
        if (delay === undefined) {
          throw this.#bootConnectError(delays.length + 1, delays, lastError ?? toError(error))
        }
        if (!isRetryableBootError(lastError)) throw lastError
        await this.#sleep(delay)
      }
    }
  }

  /** 重试耗尽：保留最后一次原因 + 冷启动语义提示，并标记可重试。 */
  #bootConnectError(attempts: number, delays: number[], lastError: Error): Error {
    const totalMs = delays.reduce((sum, delay) => sum + delay, 0)
    const message = bootRetryExhaustedMessage(attempts, totalMs, lastError)
    if (lastError instanceof AdbError) {
      return new AdbError(message, lastError.code, { cause: lastError, retryable: true })
    }
    return new Error(message, { cause: lastError })
  }

  /**
   * 设备真正可用（issue #67，可选）：轮询 sys.boot_completed=1 且 pm 可用。
   * 超时/命令失败都不抛错（后续截图重试兜底），只让 bootMs 更真实、首帧更快可用。
   */
  async #waitDeviceReady(): Promise<void> {
    if (this.#deps.waitBootCompleted !== true) return
    const device = this.#device
    if (!device) return
    const timeoutMs = this.#deps.bootReadyTimeoutMs ?? 90_000
    const deadline = this.#now() + timeoutMs
    this.#bootPhase = 'waiting-boot'
    while (this.#now() < deadline) {
      const completed = await device
        .shell('getprop sys.boot_completed')
        .catch(() => '')
      if (completed.trim() === '1') {
        // issue #67：boot_completed 还不够，boot animation 结束 + pm 可用才算真正可用
        const bootanim = await device
          .shell('getprop init.svc.bootanim')
          .catch(() => '')
        const packageManager = await device.shell('pm path android').catch(() => '')
        if (bootanim.trim() === 'stopped' && packageManager.includes('package:')) {
          this.#bootPhase = 'ready'
          return
        }
      }
      await this.#sleep(250)
    }
  }

  #sleep(delayMs: number): Promise<void> {
    const sleep = this.#deps.sleep
    if (sleep) return sleep(delayMs)
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      timer.unref?.()
    })
  }

  async #attachAdb(endpoint: Endpoint): Promise<void> {
    await this.#disconnectAdb()
    this.#usage = undefined
    this.#usageAt = 0
    const connection = await this.#deps.connect(endpoint)
    this.#connection = connection
    this.#device = this.#deps.createDevice(connection)
    void connection.disconnected.then(
      () => {
        if (this.#connection !== connection) return
        this.#connection = undefined
        this.#device = undefined
        void this.#closeSessions()
        // issue #36：ADB 断连视为 adapter 不可用，丢弃探测缓存，下次调用重探
        this.#dropHandle()
        this.#lifecycle.notifyDisconnected('ADB 连接已断开')
        this.#emitStatus()
      },
      () => undefined,
    )
  }

  async #disconnectAdb(): Promise<void> {
    const connection = this.#connection
    this.#connection = undefined
    this.#device = undefined
    if (connection) await this.#deps.disconnect(connection).catch(() => undefined)
  }

  /**
   * 解析运行时（issue #36 缓存语义）：
   * - 成功 handle 缓存；
   * - 失败不永久缓存：错误保留 `RUNTIME_PROBE_RETRY_MS` 作为最短重探间隔，到期后重探；
   * - runtime / onboarding.status/choice 变化立即失效（volatile 热更新路径）。
   */
  async #runtime(): Promise<RuntimeHandle> {
    this.#invalidateOnConfigChange()
    if (this.#handle) return this.#handle
    if (this.#handleError !== undefined) {
      if (this.#now() - this.#handleErrorAt < RUNTIME_PROBE_RETRY_MS) {
        throw this.#handleError
      }
      this.#handleError = undefined
      this.#handleErrorAt = 0
    }
    try {
      const handle = await this.#deps.resolveRuntime()
      this.#handle = handle
      this.#handleError = undefined
      this.#handleErrorAt = 0
      this.#configFingerprint = runtimeConfigFingerprint(this.#deps.config())
      this.#platform = handle.detection.platform
      return handle
    } catch (error) {
      this.#handleError = toError(error)
      this.#handleErrorAt = this.#now()
      throw error
    }
  }

  /**
   * 配置变化（runtime / onboarding / attach.endpoint / attach.resolved）→
   * 丢弃成功 handle 与失败缓存；返回是否发生变化。
   */
  #invalidateOnConfigChange(): boolean {
    const fingerprint = runtimeConfigFingerprint(this.#deps.config())
    if (this.#configFingerprint === fingerprint) return false
    this.#configFingerprint = fingerprint
    this.#handle = undefined
    this.#handleError = undefined
    this.#handleErrorAt = 0
    return true
  }

  /**
   * R4b（issue #70）：配置写完后强制丢弃旧 adapter/ADB，按**当前**配置重连，
   * 并在**新连接**上执行 getprop 真实验证；失败返回 stopped + lastError，
   * 由 HTTP 层映射为 502 E_DEVICE_DISCONNECTED（不再假通过）。
   */
  async reconnectAndVerify(): Promise<PhoneStatus> {
    this.#assertAlive()
    await this.#closeSessions()
    await this.#disconnectAdb()
    this.#dropHandle()
    this.#invalidateOnConfigChange()
    this.#lifecycle.notifyDisconnected('配置写入后重新连接')
    this.#emitStatus()
    try {
      await this.ensureRunning()
      const device = this.#requireDevice()
      // 在新连接上真实执行设备命令，证明不是复用了旧 ADB 连接
      await device.shell('getprop ro.product.model')
      return await this.status()
    } catch (error) {
      this.#handleError = toError(error)
      this.#handleErrorAt = this.#now()
      return this.#degradedStatus(toError(error).message)
    }
  }

  /** 失败时的最小状态（避免 status() 再次因探测失败抛错）。 */
  #degradedStatus(message: string): PhoneStatus {
    const config = this.#deps.config()
    const lifecycle = this.#lifecycle.status
    const status: PhoneStatus = {
      state: lifecycle.state,
      runtime: this.#handle?.detection.kind ?? (config.runtime === 'auto' ? 'attach' : config.runtime),
      platform: this.#handle?.detection.platform ?? this.#platform,
      lastError: lifecycle.lastError ?? message,
    }
    if (config.attach.endpoint) {
      const endpoint = parseEndpoint(config.attach.endpoint)
      if (endpoint) status.endpoint = endpoint
    }
    return status
  }

  /** 丢弃成功 handle（保留失败缓存，以免防抖被绕过）。 */
  #dropHandle(): void {
    this.#handle = undefined
    this.#configFingerprint = runtimeConfigFingerprint(this.#deps.config())
  }

  /**
   * adapter 明确不可用（未运行且未 paused）且生命周期已回到 stopped 时，
   * 失效成功 handle，下一次 status/工具调用重新探测。
   */
  #invalidateIfAdapterUnavailable(
    handle: RuntimeHandle,
    runtimeStatus: { running: boolean; paused: boolean } | undefined,
  ): void {
    if (runtimeStatus === undefined) return
    if (runtimeStatus.running || runtimeStatus.paused) return
    if (this.#lifecycle.state !== 'stopped') return
    if (this.#handle === handle) this.#dropHandle()
  }

  /** 观众活动也算 idle 交互（节流 30s，避免每帧 touch）。 */
  #markViewerActive(): void {
    const now = this.#now()
    if (now - this.#lastViewerTouchAt < 30_000) return
    this.#lastViewerTouchAt = now
    this.#lifecycle.touch({ wake: false })
  }

  #requireConnection(): AdbConnectionLike {
    if (!this.#connection) throw new Error('ADB 未连接：请先 ensureRunning（booting 时等待后重试）')
    return this.#connection
  }

  #requireDevice(): DeviceOps {
    if (!this.#device) throw new Error('ADB 未连接：请先 ensureRunning（booting 时等待后重试）')
    return this.#device
  }

  /* ---------------------------------- 控制通道与流 ---------------------------------- */

  async #controlSession(): Promise<StreamSession> {
    if (this.#stream) return this.#stream
    if (this.#control) return this.#control
    await this.ensureRunning()
    const config = this.#deps.config()
    const session = await this.#deps.startStream({
      // stream 层收的是 AdbConnection 本身（内部读 adb.raw）；传 Tango Adb 会 undefined（issue #59）
      adb: this.#requireConnection(),
      video: false,
      config: config.stream,
    })
    this.#control = session
    return session
  }

  async #closeSessions(): Promise<void> {
    this.#cancelClose()
    this.#stopViewerHeartbeat()
    const stream = this.#stream
    const control = this.#control
    this.#stream = undefined
    this.#control = undefined
    this.#viewers = 0
    this.#streamToken += 1
    if (stream) await stream.close().catch(() => undefined)
    if (control) await control.close().catch(() => undefined)
  }

  /** viewer 存活心跳：每 60s touch 生命周期，idle 计时不会在有人观看时到期（issue #73）。 */
  #armViewerHeartbeat(): void {
    this.#stopViewerHeartbeat()
    const schedule = this.#deps.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
    this.#viewerHeartbeat = schedule(() => {
      this.#viewerHeartbeat = undefined
      if (this.#viewers <= 0 || this.#disposed) return
      this.#lifecycle.touch()
      this.#armViewerHeartbeat()
    }, VIEWER_HEARTBEAT_MS)
  }

  #stopViewerHeartbeat(): void {
    if (this.#viewerHeartbeat) {
      this.#viewerHeartbeat()
      this.#viewerHeartbeat = undefined
    }
  }

  #scheduleClose(): void {
    this.#cancelClose()
    const schedule = this.#deps.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
    this.#closeTimer = schedule(() => {
      this.#closeTimer = undefined
      void this.#closeSessions()
    }, DEFAULT_STREAM_GRACE_MS)
  }

  #cancelClose(): void {
    if (this.#closeTimer) {
      this.#closeTimer()
      this.#closeTimer = undefined
    }
  }

  /* ---------------------------------- 内部工具 ---------------------------------- */

  #serial<T>(work: () => Promise<T>): Promise<T> {
    this.#serialPending += 1
    const next = this.#queue.then(work, work)
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next.finally(() => {
      this.#serialPending -= 1
    })
  }

  /**
   * 生命周期变更只做状态广播，**不在这里触发运行时探测**（issue #36）：
   * 否则启动失败后的 stopped 事件会立刻重探，绕过 30s 防抖并造成探测风暴。
   */
  #emit(status: LifecycleStatusLike): void {
    void status
    this.#emitStatus()
  }

  #emitStatus(): void {
    void this.#emitStatusWith(this.#handle)
  }

  #emitStatusWith(handle: RuntimeHandle | undefined): void {
    const lifecycle = this.#lifecycle.status
    const config = this.#deps.config()
    const status: PhoneStatus = {
      state: lifecycle.state,
      runtime: handle?.detection.kind ?? (config.runtime === 'auto' ? 'attach' : config.runtime),
      platform: handle?.detection.platform ?? this.#platform,
    }
    if (lifecycle.bootMs !== undefined) status.bootMs = lifecycle.bootMs
    if (lifecycle.state === 'booting' && this.#bootPhase !== undefined) {
      status.phase = this.#bootPhase
    }
    const runtimeStatus = this.#lastRuntimeStatus
    if (runtimeStatus) {
      status.owned = runtimeStatus.owned
      status.adopted = runtimeStatus.adopted
      if (runtimeStatus.pid !== undefined) status.pid = runtimeStatus.pid
    }
    if (lifecycle.lastError) status.lastError = lifecycle.lastError
    for (const listener of this.#listeners) {
      try {
        listener(status)
      } catch {
        // 订阅者异常不影响服务
      }
    }
  }

  /**
   * 资源占用（issue #56，尽力而为）：优先用 runtime 适配器给的采样
   * （redroid docker stats / emulator /proc），attach 用设备 shell 采样并缓存 5s；
   * 取不到就省略字段，不影响 status。
   */
  async #measureUsage(
    kind: RuntimeKind,
    runtimeStatus: { cpuPct?: number; memPct?: number } | undefined,
  ): Promise<ProcessUsage> {
    const fromRuntime: ProcessUsage = {}
    if (runtimeStatus?.cpuPct !== undefined) fromRuntime.cpuPct = runtimeStatus.cpuPct
    if (runtimeStatus?.memPct !== undefined) fromRuntime.memPct = runtimeStatus.memPct
    if (fromRuntime.cpuPct !== undefined || fromRuntime.memPct !== undefined) {
      return fromRuntime
    }
    if (this.#lifecycle.state !== 'running') return {}
    if (kind !== 'attach' || !this.#device || this.#serialPending > 0) return {}
    const now = this.#now()
    if (this.#usageAt !== 0 && now - this.#usageAt < USAGE_CACHE_MS) {
      return this.#usage ?? {}
    }
    const usage = await this.#sampleAttachUsage()
    this.#usage = usage
    this.#usageAt = now
    return usage
  }

  async #sampleAttachUsage(): Promise<ProcessUsage> {
    const device = this.#device
    if (!device) return {}
    try {
      const [cpuText, memText] = await Promise.all([
        device.shell(ATTACH_CPU_COMMAND),
        device.shell(ATTACH_MEM_COMMAND),
      ])
      return usageFromAttachOutputs(cpuText, memText)
    } catch {
      return {}
    }
  }

  /* ------------------------------- #83 动作与看门狗 ------------------------------- */

  #runAction(action: ActionName, work: () => Promise<PhoneStatus>): Promise<PhoneStatus> {
    this.#assertAlive()
    const inflight = this.#actionInflight
    if (inflight) {
      if (inflight.action === action) return inflight.promise
      const chained = inflight.promise
        .catch(() => undefined)
        .then(() => this.#executeAction(action, work))
      this.#actionInflight = { action, promise: chained }
      return chained
    }
    const promise = this.#executeAction(action, work)
    this.#actionInflight = { action, promise }
    return promise
  }

  #executeAction(action: ActionName, work: () => Promise<PhoneStatus>): Promise<PhoneStatus> {
    const token = ++this.#actionToken
    const previous = this.#actionQueue
    const run = previous.catch(() => undefined).then(work)
    this.#actionQueue = run.catch(() => undefined)
    const timeoutMs = this.#deps.actionTimeoutMs ?? 180_000
    const timed = withTimeout(
      run,
      timeoutMs,
      () =>
        new RuntimeError(
          '动作 ' + action + ' 超时（' + timeoutMs + 'ms）',
          action === 'stop' ? 'stop' : 'start',
        ),
    ).finally(() => {
      if (this.#actionToken === token) this.#actionInflight = undefined
    })
    return timed
  }

  async #adapterStatus(): Promise<RuntimeStatus | undefined> {
    const handle = await this.#runtime().catch(() => undefined)
    if (!handle) return undefined
    const status = await handle.adapter.status().catch(() => undefined)
    if (status) this.#lastRuntimeStatus = status
    return status
  }

  /**
   * 停止（issue #83）：
   * - booting：cancelStart 打断启动，立即落 stopped（不泄漏进程）；
   * - adopted：只断开 ADB/流，不杀用户实例，lastError 提示；
   * - owned：lifecycle.stopNow() → hooks.stop（adapter.stop 保存快照并等退出）。
   */
  async #doStop(options: StopOptions): Promise<PhoneStatus> {
    if (this.#lifecycle.state === 'stopped') return this.status()
    const runtimeStatus = await this.#adapterStatus()
    const owned = runtimeStatus?.owned ?? runtimeStatus?.adopted !== true
    if (this.#lifecycle.state === 'booting') {
      const handle = this.#handle
      await withTimeout(
        handle?.adapter.cancelStart?.() ?? Promise.resolve(),
        15_000,
        () => new RuntimeError('取消启动超时', 'stop'),
      ).catch(() => undefined)
      await this.#closeSessions().catch(() => undefined)
      await this.#disconnectAdb().catch(() => undefined)
      this.#lifecycle.halt(options.force === true ? '已停止' : '已停止（启动被取消）')
      this.#emitStatus()
      return this.status()
    }
    if (!owned) {
      await this.#closeSessions().catch(() => undefined)
      await this.#disconnectAdb().catch(() => undefined)
      this.#lifecycle.halt('已断开连接（实例由用户启动，未关闭）')
      this.#emitStatus()
      return this.status()
    }
    await this.#lifecycle.stopNow()
    this.#emitStatus()
    return this.status()
  }

  #syncWatchdog(state: PhoneState): void {
    const shouldWatch = state === 'running' || state === 'booting'
    if (!shouldWatch) {
      this.#stopWatchdog()
      return
    }
    if (this.#watchdogStop || this.#disposed) return
    const intervalMs = this.#deps.watchdogIntervalMs ?? 2000
    const schedule =
      this.#deps.setInterval ??
      ((callback: () => void, ms: number) => {
        const timer = setInterval(callback, ms)
        timer.unref?.()
        return () => clearInterval(timer)
      })
    this.#watchdogStop = schedule(() => {
      void this.#watchdogTick()
    }, intervalMs)
  }

  #stopWatchdog(): void {
    if (this.#watchdogStop) {
      this.#watchdogStop()
      this.#watchdogStop = undefined
    }
  }

  /** 每 2s 对账（issue #83）：外部 kill/端口消失 → ≤2s 内 stopped + lastError + 清流。 */
  async #watchdogTick(): Promise<void> {
    if (this.#disposed || this.#disposing) return
    const action = this.#actionInflight?.action
    if (action === 'stop' || action === 'restart') return
    const state = this.#lifecycle.state
    if (state !== 'running' && state !== 'booting') return
    const handle = this.#handle
    if (!handle) return
    const alive = await handle.adapter.isAlive().catch(() => false)
    if (alive) return
    if (this.#lifecycle.state !== state) return
    await this.#handleExternalGone()
  }

  async #handleExternalGone(): Promise<void> {
    const handle = this.#handle
    await handle?.adapter.cancelStart?.().catch(() => undefined)
    await this.#closeSessions().catch(() => undefined)
    await this.#disconnectAdb().catch(() => undefined)
    this.#lifecycle.halt('实例已被外部关闭（pid 消失/端口关闭）')
    this.#handleError = undefined
    this.#handleErrorAt = 0
    this.#emitStatus()
  }

  #delay(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      timer.unref?.()
    })
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error('PhoneService 已释放')
  }
}