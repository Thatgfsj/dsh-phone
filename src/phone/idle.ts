/**
 * idle / paused 计时器（architecture.md §5：计时逻辑独立于状态机）。
 *
 * 状态机只关心“到点了要做什么”，计时器只关心“什么时候到点”，
 * 两者用回调连接；时钟可注入，单测用假时钟验证 5min/30min，不真的等。
 */

export interface Clock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface IdleTimerOptions {
  /** running → paused 的空闲阈值。 */
  idleTimeoutMs: number
  /** paused → stopped 的空闲阈值。 */
  pausedTimeoutMs: number
  /** 空闲到点回调（状态机据此进入 paused）。 */
  onIdle(): void
  /** paused 到点回调（状态机据此进入 stopped）。 */
  onExpire(): void
  clock?: Clock
}

export class IdleTimer {
  readonly #idleTimeoutMs: number
  readonly #pausedTimeoutMs: number
  readonly #onIdle: () => void
  readonly #onExpire: () => void
  readonly #clock: Clock
  #idleHandle: unknown
  #pausedHandle: unknown
  #disposed = false

  constructor(options: IdleTimerOptions) {
    this.#idleTimeoutMs = options.idleTimeoutMs
    this.#pausedTimeoutMs = options.pausedTimeoutMs
    this.#onIdle = options.onIdle
    this.#onExpire = options.onExpire
    this.#clock = options.clock ?? systemClock
  }

  /** 进入/保持在 running：重排 idle 计时（任何交互都调用它）。 */
  armIdle(): void {
    if (this.#disposed) return
    this.clearIdle()
    if (!Number.isFinite(this.#idleTimeoutMs) || this.#idleTimeoutMs <= 0) return
    this.#idleHandle = this.#clock.setTimeout(() => {
      this.#idleHandle = undefined
      if (!this.#disposed) this.#onIdle()
    }, this.#idleTimeoutMs)
  }

  /** 进入 paused：开始 paused → stopped 倒计时。 */
  armPaused(): void {
    if (this.#disposed) return
    this.clearPaused()
    if (!Number.isFinite(this.#pausedTimeoutMs) || this.#pausedTimeoutMs <= 0) {
      return
    }
    this.#pausedHandle = this.#clock.setTimeout(() => {
      this.#pausedHandle = undefined
      if (!this.#disposed) this.#onExpire()
    }, this.#pausedTimeoutMs)
  }

  clearIdle(): void {
    if (this.#idleHandle === undefined) return
    this.#clock.clearTimeout(this.#idleHandle)
    this.#idleHandle = undefined
  }

  clearPaused(): void {
    if (this.#pausedHandle === undefined) return
    this.#clock.clearTimeout(this.#pausedHandle)
    this.#pausedHandle = undefined
  }

  clear(): void {
    this.clearIdle()
    this.clearPaused()
  }

  /** 释放后所有回调都被丢弃（插件卸载）。 */
  dispose(): void {
    this.#disposed = true
    this.clear()
  }
}
