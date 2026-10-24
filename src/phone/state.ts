/**
 * 生命周期状态机（SPEC §3.4 / §3.5，INTERFACES §3，architecture §6）。
 *
 * ```
 * stopped ──(首次工具调用/打开面板)──▶ running ──(idle 5min)──▶ paused
 *    ▲                                  │                       │
 *    └──(paused 30min 或资源紧张)────────┴──(任意交互，亚秒~6s)──┘
 * ```
 *
 * 实现要点：
 * - **懒启动**：构造时不动任何外部资源，只有 `ensureRunning()` 才拉起；
 * - **single-flight**：并发 `ensureRunning()` 合并为一次 start/resume；
 * - **booting 中间态**：启动期间的调用共享同一个 promise（工具层可等待后重试）；
 * - 计时逻辑在 `idle.ts`，时钟注入以便单测不真的等 5min/30min。
 */

import { IdleTimer, systemClock } from './idle.ts'
import type { Clock } from './idle.ts'
import type { PhoneState } from '../runtime/types.ts'

export type { Clock } from './idle.ts'
export { systemClock } from './idle.ts'

export type LifecyclePhase = 'start' | 'resume' | 'pause' | 'stop'

export interface LifecycleTimings {
  /** running → paused 的空闲阈值，默认 5min。 */
  idleTimeoutMs: number
  /** paused → stopped 的空闲阈值，默认 30min。 */
  pausedTimeoutMs: number
  /** booting 上限，默认 120s（覆盖 redroid 8–15s / emulator 20–40s）。 */
  bootTimeoutMs: number
}

export const DEFAULT_LIFECYCLE_TIMINGS: LifecycleTimings = {
  idleTimeoutMs: 300_000,
  pausedTimeoutMs: 1_800_000,
  bootTimeoutMs: 120_000,
}

/** 状态机需要宿主提供的外部动作（adapter + ADB 连接由 service 层编排）。 */
export interface LifecycleHooks {
  /** stopped → running：adapter.ensureRunning + 建立 ADB 连接。 */
  start(): Promise<void>
  /** running → paused：redroid pause / emulator 快照 / attach 断开。 */
  pause(): Promise<void>
  /** paused → running：unpause / 快照恢复 / attach 重连。 */
  resume(): Promise<void>
  /** → stopped：redroid stop / emulator kill / attach 断开。 */
  stop(): Promise<void>
  onError?(error: Error, phase: LifecyclePhase): void
}

export interface LifecycleStatus {
  state: PhoneState
  /** 进入当前状态的时间戳（ms）。 */
  since: number
  /** booting 时是已耗时；running/paused 时是最近一次启动耗时。 */
  bootMs?: number
  lastError?: string
}

export interface TouchOptions {
  /** paused 时是否顺手唤醒（默认 true，符合 SPEC“任意交互自动唤醒”）。 */
  wake?: boolean
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export class PhoneLifecycle {
  readonly #hooks: LifecycleHooks
  readonly #timings: LifecycleTimings
  readonly #clock: Clock
  readonly #idle: IdleTimer
  readonly #listeners = new Set<(status: LifecycleStatus) => void>()
  #state: PhoneState = 'stopped'
  #since: number
  #lastError: string | undefined
  #bootStartedAt: number | undefined
  #bootMs: number | undefined
  #inflight: Promise<void> | undefined
  #pausing: Promise<void> | undefined
  #disposed = false

  constructor(
    hooks: LifecycleHooks,
    timings: LifecycleTimings = DEFAULT_LIFECYCLE_TIMINGS,
    clock: Clock = systemClock,
  ) {
    this.#hooks = hooks
    this.#timings = timings
    this.#clock = clock
    this.#since = clock.now()
    this.#idle = new IdleTimer({
      idleTimeoutMs: timings.idleTimeoutMs,
      pausedTimeoutMs: timings.pausedTimeoutMs,
      clock,
      onIdle: () => {
        void this.#enterPaused()
      },
      onExpire: () => {
        void this.#enterStopped()
      },
    })
  }

  get state(): PhoneState {
    return this.#state
  }

  get status(): LifecycleStatus {
    const status: LifecycleStatus = { state: this.#state, since: this.#since }
    if (this.#state === 'booting' && this.#bootStartedAt !== undefined) {
      status.bootMs = this.#clock.now() - this.#bootStartedAt
    } else if (this.#bootMs !== undefined) {
      status.bootMs = this.#bootMs
    }
    if (this.#lastError !== undefined) status.lastError = this.#lastError
    return status
  }

  onChange(listener: (status: LifecycleStatus) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 懒启动 / 唤醒。并发调用合并为一次启动（single-flight）；
   * booting 期间的调用等待同一个 promise（工具层不报错，等待后重试）。
   */
  async ensureRunning(): Promise<void> {
    if (this.#disposed) throw new Error('PhoneLifecycle 已释放')

    // 正在休眠（idle → pause）时先等它落定，避免 paused/running 竞态
    if (this.#pausing) {
      await this.#pausing.catch(() => undefined)
    }

    if (this.#state === 'running') {
      this.#idle.armIdle()
      return
    }
    if (this.#inflight) {
      return this.#inflight
    }

    const resuming = this.#state === 'paused'
    this.#inflight = this.#boot(resuming)
    try {
      await this.#inflight
    } finally {
      this.#inflight = undefined
    }
  }

  /**
   * 交互信号：重置 idle 计时；paused 时默认顺手唤醒（redroid 亚秒 / emulator 3–6s /
   * attach 重连即恢复）。
   */
  touch(options: TouchOptions = {}): void {
    if (this.#disposed) return
    if (this.#state === 'running') {
      this.#idle.armIdle()
      return
    }
    if (this.#state === 'paused') {
      this.#idle.clearPaused()
      if (options.wake !== false && !this.#inflight) {
        void this.ensureRunning().catch(() => undefined)
      }
    }
  }

  /** ADB 断连上报：连接已不可用，状态回到 stopped，等下次 ensureRunning 重连。 */
  notifyDisconnected(reason?: string): void {
    if (this.#disposed || this.#state === 'stopped') return
    this.#idle.clear()
    this.#lastError = reason ?? 'ADB 连接已断开'
    this.#bootStartedAt = undefined
    this.#transition('stopped')
  }

  /** 释放定时器与订阅（插件卸载时调用）。 */
  async dispose(): Promise<void> {
    this.#disposed = true
    this.#idle.dispose()
    this.#listeners.clear()
    if (this.#inflight) {
      await this.#inflight.catch(() => undefined)
    }
  }

  async #boot(resuming: boolean): Promise<void> {
    const phase: LifecyclePhase = resuming ? 'resume' : 'start'
    const previous: PhoneState = resuming ? 'paused' : 'stopped'
    this.#lastError = undefined
    this.#idle.clear()
    this.#bootStartedAt = this.#clock.now()
    this.#transition('booting')

    try {
      await this.#withBootTimeout(
        resuming ? this.#hooks.resume() : this.#hooks.start(),
        phase,
      )
      this.#bootMs = this.#clock.now() - (this.#bootStartedAt ?? this.#clock.now())
      this.#bootStartedAt = undefined
      this.#transition('running')
      this.#idle.armIdle()
    } catch (error) {
      this.#bootStartedAt = undefined
      const failure = toError(error)
      this.#lastError = failure.message
      this.#transition(previous)
      this.#hooks.onError?.(failure, phase)
      throw failure
    }
  }

  #withBootTimeout(work: Promise<void>, phase: LifecyclePhase): Promise<void> {
    const timeoutMs = this.#timings.bootTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work
    return new Promise<void>((resolve, reject) => {
      const handle = this.#clock.setTimeout(() => {
        reject(
          new Error(
            phase === 'start'
              ? `实例启动超时（${timeoutMs}ms）`
              : `实例唤醒超时（${timeoutMs}ms）`,
          ),
        )
      }, timeoutMs)
      work.then(
        () => {
          this.#clock.clearTimeout(handle)
          resolve()
        },
        (error: unknown) => {
          this.#clock.clearTimeout(handle)
          reject(error)
        },
      )
    })
  }

  async #enterPaused(): Promise<void> {
    if (this.#state !== 'running') return
    this.#pausing = (async () => {
      try {
        await this.#hooks.pause()
      } catch (error) {
        const failure = toError(error)
        this.#lastError = failure.message
        this.#hooks.onError?.(failure, 'pause')
        // 暂停失败就继续跑，稍后重试 idle 计时，不要把状态机卡住
        this.#idle.armIdle()
        return
      }
      if (this.#state !== 'running') return
      this.#transition('paused')
      this.#idle.armPaused()
    })()
    try {
      await this.#pausing
    } finally {
      this.#pausing = undefined
    }
  }

  async #enterStopped(): Promise<void> {
    if (this.#state !== 'paused') return
    try {
      await this.#hooks.stop()
    } catch (error) {
      const failure = toError(error)
      this.#lastError = failure.message
      this.#hooks.onError?.(failure, 'stop')
    }
    if (this.#state !== 'paused') return
    this.#transition('stopped')
    this.#bootMs = undefined
  }

  #transition(next: PhoneState): void {
    if (this.#state === next) return
    this.#state = next
    this.#since = this.#clock.now()
    const status = this.status
    for (const listener of this.#listeners) {
      try {
        listener(status)
      } catch {
        // 订阅者异常不影响状态机
      }
    }
  }
}
