/**
 * 生命周期控制（issue #83，host 侧）。
 *
 * 把 PhoneService 的 start/stop/restart 包装成**异步、单队列互斥**的动作，并给
 * GET /dsh-phone/api/runtime 提供稳定快照。运行时方法由 runtime 并行实现
 * （PhoneService.start/stop/restart + status.owned/adopted/pid）；本模块用
 * 能力探测调用，未合并时 `stop/restart` 会以结构化 `E_STOP_FAILED` 记录在 lastError，
 * 合入后无需改 host 接线。
 */
import type { Endpoint, PhoneState } from './contracts.ts'
import type { PhoneStatus } from './contracts.ts'

export const RUNTIME_ACTIONS = ['start', 'stop', 'restart'] as const
export type RuntimeAction = (typeof RUNTIME_ACTIONS)[number]

export type LifecycleErrorCode =
  | 'E_START_FAILED'
  | 'E_STOP_FAILED'
  | 'E_RESTART_FAILED'
  | 'E_LIFECYCLE_BUSY'

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode

  constructor(code: LifecycleErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LifecycleError'
    this.code = code
  }
}

/** GET /dsh-phone/api/runtime 的 value（字段稳定，供 client #84 轮询）。 */
export interface RuntimeInfo {
  state: PhoneState
  running: boolean
  owned: boolean
  adopted: boolean
  pid?: number
  endpoint?: Endpoint
  since?: number
  busy: boolean
  lastError?: string
}

/** 运行时需要暴露给 host 的最小能力（PhoneService 结构上满足；可选方法用于灰度）。 */
export interface LifecycleServiceLike {
  status(): Promise<PhoneStatus>
  start?(): Promise<unknown>
  stop?(options?: { force?: boolean }): Promise<unknown>
  restart?(): Promise<unknown>
  ensureRunning?(): Promise<void>
}

export interface LifecycleControllerLike {
  info(): Promise<RuntimeInfo>
  /** 异步入队；HTTP 层立即 202，UI 轮询 info()。 */
  enqueue(action: RuntimeAction): void
  dispose(): void
}

function actionErrorCode(action: RuntimeAction): LifecycleErrorCode {
  if (action === 'stop') return 'E_STOP_FAILED'
  if (action === 'start') return 'E_START_FAILED'
  return 'E_RESTART_FAILED'
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class LifecycleController implements LifecycleControllerLike {
  readonly #service: LifecycleServiceLike
  #queue: Promise<void> = Promise.resolve()
  #pending = 0
  #inflight = false
  #lastError: string | undefined
  #disposed = false

  constructor(service: LifecycleServiceLike) {
    this.#service = service
  }

  async info(): Promise<RuntimeInfo> {
    const status = await this.#service.status()
    const info: RuntimeInfo = {
      state: status.state,
      running: status.state === 'running' || status.state === 'paused',
      owned: status.owned === true,
      adopted: status.adopted === true,
      busy: this.#inflight || this.#pending > 0,
    }
    if (status.pid !== undefined) info.pid = status.pid
    if (status.endpoint !== undefined) info.endpoint = status.endpoint
    if (status.since !== undefined) info.since = status.since
    const lastError = this.#lastError ?? status.lastError
    if (lastError !== undefined) info.lastError = lastError
    return info
  }

  enqueue(action: RuntimeAction): void {
    if (this.#disposed) return
    this.#pending += 1
    this.#queue = this.#queue
      .then(() => this.#execute(action))
      .catch(() => undefined)
  }

  /** 卸载不等待动作（由 runtime 内部 dispose/取消启动负责，host 不阻塞）。 */
  dispose(): void {
    this.#disposed = true
    this.#pending = 0
  }

  async #execute(action: RuntimeAction): Promise<void> {
    this.#pending = Math.max(0, this.#pending - 1)
    this.#inflight = true
    try {
      await this.#invoke(action)
      this.#lastError = undefined
    } catch (error) {
      this.#lastError = actionErrorCode(action) + ': ' + toMessage(error)
    } finally {
      this.#inflight = false
    }
  }

  async #invoke(action: RuntimeAction): Promise<void> {
    if (action === 'start') {
      if (this.#service.start !== undefined) {
        await this.#service.start()
        return
      }
      if (this.#service.ensureRunning !== undefined) {
        await this.#service.ensureRunning()
        return
      }
      throw new LifecycleError('E_START_FAILED', '当前运行时没有 start 能力')
    }
    if (action === 'stop') {
      if (this.#service.stop === undefined) {
        throw new LifecycleError(
          'E_STOP_FAILED',
          '当前运行时版本不支持 stop（需要 runtime #83）；请重载到包含 lifecycle API 的版本',
        )
      }
      await this.#service.stop({ force: false })
      return
    }
    if (this.#service.restart !== undefined) {
      await this.#service.restart()
      return
    }
    // 灰度回退：runtime 尚未提供 restart 时，按 stop → start 串行执行。
    if (this.#service.stop === undefined) {
      throw new LifecycleError(
        'E_RESTART_FAILED',
        '当前运行时版本不支持 restart/stop（需要 runtime #83）',
      )
    }
    await this.#service.stop({ force: false })
    await this.#invoke('start')
  }
}

/** 仅允许这三种 action（HTTP body 校验复用）。 */
export function isRuntimeAction(value: unknown): value is RuntimeAction {
  return typeof value === 'string' && (RUNTIME_ACTIONS as readonly string[]).includes(value)
}
