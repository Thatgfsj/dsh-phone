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
import type { Endpoint, PhoneState, RuntimeAdapter, RuntimeKind } from '../runtime/types.ts'
import {
  DEFAULT_BOOT_TIMEOUT_MS,
  bootRetryDelays,
  bootRetryExhaustedMessage,
  isRetryableBootError,
} from './boot-retry.ts'
import type {
  InteractiveReadiness,
  PhoneOperations,
  PhoneStatus,
  Platform,
  VerifyResult,
} from './contracts.ts'

export interface ServiceConfig {
  /** 生效运行时（已叠加 onboarding.choice；wiring.readServiceConfig）。 */
  runtime: 'auto' | RuntimeKind
  /** onboarding 原始状态：用于配置变化时使探测缓存失效（issue #36）。 */
  onboarding?: { status: OnboardingStatus; choice: OnboardingChoice }
  attach: { endpoint: string; userHint: string; resolved: boolean }
  stream: { maxSize: number; maxFps: number; bitrate: number }
  lifecycle: { idleTimeoutMs: number; pausedTimeoutMs: number }
}

/** runtime 适配器 + 决策树结果（detect.ts / resolveRuntime 的窄化）。 */
export interface RuntimeHandle {
  adapter: RuntimeAdapter
  detection: { kind: RuntimeKind; platform: Platform }
}

export interface AdbConnectionLike {
  readonly raw: unknown
  readonly disconnected: Promise<void>
  close(): Promise<void>
}

/** adb/device 设备语义（src/adb/device.ts 的窄化，测试可注入假实现）。 */
export interface DeviceOps {
  screenshot(): Promise<Uint8Array>
  tap(x: number, y: number): Promise<void>
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>
  key(name: string): Promise<void>
  appLaunch(pkg: string): Promise<void>
  dumpUi(): Promise<string>
  shell(command: string): Promise<string>
}

export interface StreamSink {
  video(chunk: Uint8Array, meta?: { keyframe?: boolean; pts?: bigint }): void
  error(error: Error): void
}

export interface StreamSessionOptions {
  adb: unknown
  video: boolean
  sink?: StreamSink
  config: { maxSize: number; maxFps: number; bitrate: number }
}

export interface StreamSession {
  readonly ready?: Promise<{ width: number; height: number; codec: string }>
  injectText(text: string): Promise<void>
  injectTouch(action: 'down' | 'move' | 'up', x: number, y: number): Promise<void>
  injectKey(name: string): Promise<void>
  close(): Promise<void>
}

export type StartStreamSession = (options: StreamSessionOptions) => Promise<StreamSession>

/** 生命周期状态（runtime PhoneLifecycle 的窄化）。 */
export interface LifecycleStatusLike {
  state: PhoneState
  since: number
  bootMs?: number
  lastError?: string
}

export interface LifecycleHooksLike {
  start(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  onError?(error: Error, phase: 'start' | 'resume' | 'pause' | 'stop'): void
}

export interface LifecycleLike {
  readonly state: PhoneState
  readonly status: LifecycleStatusLike
  ensureRunning(): Promise<void>
  touch(options?: { wake?: boolean }): void
  notifyDisconnected(reason?: string): void
  onChange(listener: (status: LifecycleStatusLike) => void): () => void
  dispose(): Promise<void>
}

export type CreateLifecycle = (
  hooks: LifecycleHooksLike,
  timings: { idleTimeoutMs: number; pausedTimeoutMs: number; bootTimeoutMs: number },
) => LifecycleLike

export interface PhoneServiceDeps {
  config(): ServiceConfig
  resolveRuntime(): Promise<RuntimeHandle>
  platform(): Promise<Platform>
  connect(endpoint: Endpoint, options?: { timeoutMs?: number }): Promise<AdbConnectionLike>
  disconnect(connection: AdbConnectionLike): Promise<void>
  createDevice(connection: AdbConnectionLike): DeviceOps
  startStream(options: StreamSessionOptions): Promise<StreamSession>
  createLifecycle: CreateLifecycle
  /** 流关闭宽限期（默认 5000ms；测试注入立即执行）。 */
  schedule?(callback: () => void, delayMs: number): () => void
  /** 可注入时钟（单测验证 30s 防抖；默认 Date.now）。 */
  now?(): number
  /** 注入 sleep（单测缩短冷启动重试等待；默认 setTimeout）。 */
  sleep?(delayMs: number): Promise<void>
  /** 注入 boot 重试延迟序列（默认 bootRetryDelays(DEFAULT_BOOT_TIMEOUT_MS - 20s)）。 */
  bootRetryDelays?(): number[]
}

const DEFAULT_STREAM_GRACE_MS = 5_000
/**
 * boot 重试预算（issue #44）：给每次 connect 自身（最长 8s）留出余量，
 * 保证“延迟累计 + 最后一次尝试”不会先撞上 lifecycle 的 120s boot 超时。
 */
const BOOT_RETRY_BUDGET_MS = DEFAULT_BOOT_TIMEOUT_MS - 20_000

/**
 * 探测失败后的最短重探间隔（issue #36）：失败**不永久缓存**，但 30s 内不重复探测，
 * 避免面板/status 轮询打爆决策树（docker/emulator 探测含磁盘与端口检查）。
 */
export const RUNTIME_PROBE_RETRY_MS = 30_000

/** 运行时探测缓存指纹：runtime 配置 + onboarding.status/choice 任一变化即失效。 */
export function runtimeConfigFingerprint(config: ServiceConfig): string {
  const onboarding = config.onboarding
  return [config.runtime, onboarding?.status ?? '', onboarding?.choice ?? ''].join('|')
}

function parseEndpoint(value: string): Endpoint | undefined {
  const match = /^([A-Za-z0-9._:[\]-]+):(\d{1,5})$/.exec(value.trim())
  if (!match) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host: match[1] as string, port }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

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
  #ensurePromise: Promise<void> | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false

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
    this.#lifecycle.onChange((status) => this.#emit(status))
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
    if (lifecycle.bootMs !== undefined) status.bootMs = lifecycle.bootMs
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
      await this.ensureRunning()
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
    const session = await this.#controlSession()
    await session.injectText(text)
  }

  /** scrcpy 触摸注入（与 lifecycle.touch 的 idle 唤醒信号区分，见 contracts.ts）。 */
  async touchScreen(action: 'down' | 'move' | 'up', x: number, y: number): Promise<void> {
    const session = await this.#controlSession()
    await session.injectTouch(action, x, y)
  }

  /* ---------------------------------- 视频流 ---------------------------------- */

  async startStream(sink: StreamSink): Promise<() => Promise<void>> {
    await this.ensureRunning()
    const config = this.#deps.config()
    const token = ++this.#streamToken
    this.#cancelClose()
    if (this.#stream) {
      const old = this.#stream
      this.#stream = undefined
      await old.close().catch(() => undefined)
    }
    await this.#control?.close().catch(() => undefined)
    this.#control = undefined
    const session = await this.#deps.startStream({
      adb: this.#requireConnection().raw,
      video: true,
      sink,
      config: config.stream,
    })
    if (token !== this.#streamToken) {
      await session.close().catch(() => undefined)
    } else {
      this.#stream = session
      this.#viewers = 1
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      this.#viewers = Math.max(0, this.#viewers - 1)
      if (this.#viewers === 0) this.#scheduleClose()
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

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#cancelClose()
    await this.#stream?.close().catch(() => undefined)
    await this.#control?.close().catch(() => undefined)
    await this.#disconnectAdb()
    await this.#lifecycle.dispose()
    this.#listeners.clear()
  }

  /* ---------------------------------- 生命周期钩子 --------------------------------- */

  async #start(): Promise<void> {
    const handle = await this.#runtime()
    const endpoint = await handle.adapter.ensureRunning()
    await this.#connectDuringBoot(endpoint)
  }

  async #resume(): Promise<void> {
    const handle = await this.#runtime()
    await handle.adapter.resume()
    const status = await handle.adapter.status()
    const endpoint = status.endpoint ?? parseEndpoint(this.#deps.config().attach.endpoint)
    if (!endpoint) throw new Error('resume 后无法确定 attach endpoint')
    await this.#connectDuringBoot(endpoint)
  }

  async #pause(): Promise<void> {
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
      // 启动/唤醒失败：adapter 可能已不可用，丢弃 handle 让下一次调用重新探测；
      // 探测本身失败的错误由 #runtime 缓存（30s 防抖），这里不再覆盖。
      this.#dropHandle()
      void this.#disconnectAdb()
    } else {
      this.#handleError = error
      this.#handleErrorAt = this.#now()
    }
    this.#emitStatus()
  }

  /**
   * 冷启动窗口内建立 ADB 连接（issue #44）：adbd 端口可连但握手/执行可能失败，
   * 按 500ms→1s→2s→4s→8s 退避重试，直到成功或 boot 预算耗尽。
   */
  async #connectDuringBoot(endpoint: Endpoint): Promise<void> {
    const delays = this.#deps.bootRetryDelays?.() ?? bootRetryDelays(BOOT_RETRY_BUDGET_MS)
    let lastError: Error | undefined
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#attachAdb(endpoint)
        this.#handleError = undefined
        this.#handleErrorAt = 0
        return
      } catch (error) {
        lastError = toError(error)
        const delay = delays[attempt]
        if (delay === undefined) {
          throw this.#bootConnectError(delays.length + 1, delays, lastError)
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

  /** 配置变化（runtime 或 onboarding 两叶）→ 丢弃成功 handle 与失败缓存。 */
  #invalidateOnConfigChange(): void {
    const fingerprint = runtimeConfigFingerprint(this.#deps.config())
    if (this.#configFingerprint === fingerprint) return
    this.#configFingerprint = fingerprint
    this.#handle = undefined
    this.#handleError = undefined
    this.#handleErrorAt = 0
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
      adb: this.#requireConnection().raw,
      video: false,
      config: config.stream,
    })
    this.#control = session
    return session
  }

  async #closeSessions(): Promise<void> {
    this.#cancelClose()
    const stream = this.#stream
    const control = this.#control
    this.#stream = undefined
    this.#control = undefined
    this.#viewers = 0
    this.#streamToken += 1
    if (stream) await stream.close().catch(() => undefined)
    if (control) await control.close().catch(() => undefined)
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
    const next = this.#queue.then(work, work)
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
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
    if (lifecycle.lastError) status.lastError = lifecycle.lastError
    for (const listener of this.#listeners) {
      try {
        listener(status)
      } catch {
        // 订阅者异常不影响服务
      }
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error('PhoneService 已释放')
  }
}