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
import type { Endpoint, PhoneState, RuntimeAdapter, RuntimeKind } from '../runtime/types.ts'
import type {
  InteractiveReadiness,
  PhoneOperations,
  PhoneStatus,
  Platform,
  VerifyResult,
} from './contracts.ts'

export interface ServiceConfig {
  runtime: 'auto' | RuntimeKind
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
}

const DEFAULT_BOOT_TIMEOUT_MS = 120_000
const DEFAULT_STREAM_GRACE_MS = 5_000

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
    const config = deps.config()
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
    const lastError = lifecycle.lastError ?? this.#handleError?.message
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

  async touch(action: 'down' | 'move' | 'up', x: number, y: number): Promise<void> {
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
    await this.#attachAdb(endpoint)
  }

  async #resume(): Promise<void> {
    const handle = await this.#runtime()
    await handle.adapter.resume()
    const status = await handle.adapter.status()
    const endpoint = status.endpoint ?? parseEndpoint(this.#deps.config().attach.endpoint)
    if (!endpoint) throw new Error('resume 后无法确定 attach endpoint')
    await this.#attachAdb(endpoint)
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
    this.#handleError = error
    this.#emitStatus()
    if (phase === 'start' || phase === 'resume') void this.#disconnectAdb()
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

  async #runtime(): Promise<RuntimeHandle> {
    if (this.#handle) return this.#handle
    if (this.#handleError) throw this.#handleError
    try {
      const handle = await this.#deps.resolveRuntime()
      this.#handle = handle
      this.#platform = handle.detection.platform
      return handle
    } catch (error) {
      this.#handleError = toError(error)
      throw error
    }
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

  #emit(status: LifecycleStatusLike): void {
    void this.#runtime().then(
      (handle) => this.#emitStatusWith(handle),
      () => this.#emitStatus(),
    )
    void status
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