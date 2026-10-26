/**
 * Lifecycle UI state helpers + the /runtime poller (issue #83).
 *
 * The Host runs actions asynchronously; the client polls every 1s while busy and
 * every 3s otherwise (so an external kill is noticed quickly without hammering
 * the Host). Kept React-free for unit tests with fake timers.
 */
import type { RuntimeAction, RuntimeApi, RuntimeView } from './runtime-api.ts'
import { describeOwnership, isActionAvailable, isRuntimeUnsupported, stopActionKey } from './runtime-api.ts'

/** Poll cadence while an action is executing (issue #83: 1s). */
export const RUNTIME_ACTION_POLL_MS = 1_000
/** Poll cadence while idle — catches external kills within ~3s. */
export const RUNTIME_IDLE_POLL_MS = 3_000

export interface RuntimeUiView {
  view?: RuntimeView
  /** Host without the lifecycle API (older build) — show manual/info only. */
  available: boolean
  /** No instance: the stage shows the stopped overlay with a start button. */
  stopped: boolean
  /** The last error mentions an external kill (pid gone / port closed). */
  external: boolean
  /** Action labels/capabilities derived from ownership. */
  owned: boolean
  adopted: boolean
  stopKey: string
  canStart: boolean
  canStop: boolean
  canRestart: boolean
  reason?: string
  /** Human-readable endpoint/pid line, when known. */
  identity?: string
}

/** Heuristic for the Host's "instance closed externally" lastError text. */
export function isExternalStop(lastError: string | undefined): boolean {
  if (lastError === undefined) return false
  return /外部|external|killed|gone|消失|closed by user|pid|端口关闭/i.test(lastError)
}

/** Derive everything the header/stage/settings need from the last polled view. */
export function describeRuntimeUi(view: RuntimeView | undefined, failure?: unknown): RuntimeUiView {
  if (view === undefined && failure !== undefined) {
    return {
      available: !isRuntimeUnsupported(failure),
      stopped: false,
      external: false,
      owned: false,
      adopted: false,
      stopKey: 'runtime.action.disconnect',
      canStart: false,
      canStop: false,
      canRestart: false,
    }
  }
  const ownership = describeOwnership(view)
  const identity =
    view?.endpoint !== undefined
      ? view.endpoint.host + ':' + view.endpoint.port
      : view?.pid !== undefined
        ? 'pid ' + view.pid
        : undefined
  return {
    view,
    available: true,
    stopped: (view?.state ?? 'stopped') === 'stopped',
    external: (view?.state ?? 'stopped') === 'stopped' && isExternalStop(view?.lastError),
    owned: ownership === 'owned',
    adopted: ownership === 'adopted',
    stopKey: stopActionKey(view),
    canStart: view !== undefined && isActionAvailable(view, 'start'),
    canStop: view !== undefined && isActionAvailable(view, 'stop'),
    canRestart: view !== undefined && isActionAvailable(view, 'restart'),
    reason: view?.lastError,
    identity,
  }
}

export interface RuntimeActionState {
  action?: RuntimeAction
  busy: boolean
  error?: string
  message?: string
}

/** Short status key for the runtime state (header badge / settings row). */
export function runtimeStateKey(view: RuntimeView | undefined): string {
  switch (view?.state ?? 'stopped') {
    case 'booting':
      return 'runtime.state.booting'
    case 'running':
      return 'runtime.state.running'
    case 'paused':
      return 'runtime.state.paused'
    default:
      return 'runtime.state.stopped'
  }
}

/** Map a structured lifecycle error code to a readable copy key. */
export function runtimeErrorKey(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'E_DEVICE_DISCONNECTED') return 'runtime.error.disconnected'
  if (code === 'E_STOP_FAILED') return 'runtime.error.stopFailed'
  if (code === 'E_START_FAILED') return 'runtime.error.startFailed'
  if (code === 'E_TIMEOUT') return 'runtime.error.timeout'
  if (code === 'E_BAD_REQUEST') return 'runtime.error.badRequest'
  return 'runtime.error.generic'
}

export interface RuntimePollerOptions {
  api: RuntimeApi
  onView: (view: RuntimeView) => void
  onFailure: (error: unknown) => void
  idleIntervalMs?: number
  actionIntervalMs?: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Poll `GET /runtime`: fast while an action is running, slow while idle.
 * Errors are reported but do not stop the loop (transient Host hiccups).
 */
export class RuntimePoller {
  #running = false
  #fast = false
  #timer: unknown
  #disposed = false
  readonly #options: RuntimePollerOptions
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #idleMs: number
  readonly #actionMs: number

  constructor(options: RuntimePollerOptions) {
    this.#options = options
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.#idleMs = options.idleIntervalMs ?? RUNTIME_IDLE_POLL_MS
    this.#actionMs = options.actionIntervalMs ?? RUNTIME_ACTION_POLL_MS
  }

  get polling(): boolean {
    return this.#running
  }

  get fast(): boolean {
    return this.#fast
  }

  /** Start the loop (idempotent); reads immediately. */
  start(): void {
    if (this.#running || this.#disposed) return
    this.#running = true
    void this.#tick()
  }

  /** Switch cadence; an action should call `setFast(true)` until it settles. */
  setFast(fast: boolean): void {
    if (this.#fast === fast) return
    this.#fast = fast
    if (this.#running) {
      if (this.#timer !== undefined) this.#clearTimer(this.#timer)
      this.#timer = undefined
      this.#schedule()
    }
  }

  /** Read immediately (retry/recheck buttons), even before start(). */
  async refresh(): Promise<void> {
    try {
      this.#options.onView(await this.#options.api.get())
    } catch (error) {
      this.#options.onFailure(error)
    }
  }

  stop(): void {
    this.#running = false
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = undefined
  }

  dispose(): void {
    this.#disposed = true
    this.stop()
  }

  #schedule(): void {
    const delay = this.#fast ? this.#actionMs : this.#idleMs
    this.#timer = this.#setTimer(() => {
      void this.#tick()
    }, delay)
  }

  async #tick(): Promise<void> {
    if (!this.#running || this.#disposed) return
    try {
      const view = await this.#options.api.get()
      if (!this.#running) return
      this.#options.onView(view)
    } catch (error) {
      if (!this.#running) return
      this.#options.onFailure(error)
    }
    if (this.#running) this.#schedule()
  }
}
