/**
 * PhoneService 的动作互斥队列（issue #83 从 service.ts 拆出，控制单文件行数）。
 *
 * 语义：
 * - 同动作并发 → 复用同一个 in-flight promise（不重复执行）；
 * - 不同动作 → 串行排队（start 之后 stop 会等 start 结束）；
 * - 每个动作带超时（默认 180s，可注入），超时抛 RuntimeError 供 host 映射 E_TIMEOUT/E_STOP_FAILED。
 */

import { withTimeout } from '../adb/timing.ts'
import { RuntimeError } from '../runtime/types.ts'
import type { PhoneState, RuntimeAdapter, RuntimeStatus } from '../runtime/types.ts'

export type ServiceActionName = 'start' | 'stop' | 'restart'

interface InflightAction {
  action: ServiceActionName
  promise: Promise<unknown>
}

export interface ActionQueueOptions {
  timeoutMs: number
  makeTimeoutError(action: ServiceActionName, timeoutMs: number): Error
}

export class ActionQueue {
  readonly #options: ActionQueueOptions
  #queue: Promise<unknown> = Promise.resolve()
  #inflight: InflightAction | undefined
  #token = 0

  constructor(options: ActionQueueOptions) {
    this.#options = options
  }

  /** 当前进行中的动作（看门狗据此跳过 stop/restart 期间的检查）。 */
  get currentAction(): ServiceActionName | undefined {
    return this.#inflight?.action
  }

  run<T>(action: ServiceActionName, work: () => Promise<T>): Promise<T> {
    const inflight = this.#inflight
    if (inflight) {
      if (inflight.action === action) return inflight.promise as Promise<T>
      const chained = inflight.promise
        .catch(() => undefined)
        .then(() => this.#execute(action, work))
      this.#inflight = { action, promise: chained }
      return chained
    }
    const promise = this.#execute(action, work)
    this.#inflight = { action, promise }
    return promise
  }

  #execute<T>(action: ServiceActionName, work: () => Promise<T>): Promise<T> {
    const token = ++this.#token
    const previous = this.#queue
    const run = previous.catch(() => undefined).then(work)
    this.#queue = run.catch(() => undefined)
    const timeoutMs = this.#options.timeoutMs
    return withTimeout(run, timeoutMs, () =>
      this.#options.makeTimeoutError(action, timeoutMs),
    ).finally(() => {
      if (this.#token === token) this.#inflight = undefined
    })
  }
}

export interface LifecycleGuardDeps {
  intervalMs: number
  actionTimeoutMs: number
  disposeBudgetMs: number
  /** 打断 booting 时等待 cancelStart 的上限（默认 15s）。 */
  interruptTimeoutMs?: number
  setInterval?(callback: () => void, intervalMs: number): () => void
  currentState(): PhoneState
  now(): number
  isDisposed(): boolean
  isDisposing(): boolean
  setDisposing(value: boolean): void
  currentAction(): ServiceActionName | undefined
  runtimeHandle(): { adapter: RuntimeAdapter } | undefined
  adapterStatus(): Promise<RuntimeStatus | undefined>
  cacheStatus(status: RuntimeStatus | undefined): void
  closeSessions(): Promise<void>
  disconnectAdb(): Promise<void>
  halt(reason?: string): void
  stopNow(reason?: string): Promise<void>
  disposeLifecycle(): Promise<void>
  emitStatus(): void
  clearTransientErrors(): void
}

const CANCEL_START_TIMEOUT_MS = 15_000
const DEFAULT_DISPOSE_BUDGET_MS = 5_000

function guardDelay(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    timer.unref?.()
  })
}

/**
 * issue #83：外部 kill 兜底 + stop/dispose 语义。
 * - 看门狗：running/booting 时每 2s 调 adapter.isAlive()，消失即 stopped+lastError；
 * - stop：booting → cancelStart 打断；adopted → 只断开；owned → stopNow（保存快照）；
 * - dispose：总预算 ≤5s，任何一步不无限等待；owned 先尝试 stop，adopted 只断开。
 */
export class LifecycleGuard {
  readonly #deps: LifecycleGuardDeps
  #watchdogStop: (() => void) | undefined

  constructor(deps: LifecycleGuardDeps) {
    this.#deps = deps
  }

  syncWatchdog(state: PhoneState): void {
    const shouldWatch = state === 'running' || state === 'booting'
    if (!shouldWatch) {
      this.stopWatchdog()
      return
    }
    if (this.#watchdogStop || this.#deps.isDisposed()) return
    const schedule =
      this.#deps.setInterval ??
      ((callback: () => void, ms: number) => {
        const timer = setInterval(callback, ms)
        timer.unref?.()
        return () => clearInterval(timer)
      })
    this.#watchdogStop = schedule(() => {
      void this.tick()
    }, this.#deps.intervalMs)
  }

  stopWatchdog(): void {
    if (this.#watchdogStop) {
      this.#watchdogStop()
      this.#watchdogStop = undefined
    }
  }

  async tick(): Promise<void> {
    if (this.#deps.isDisposed() || this.#deps.isDisposing()) return
    const action = this.#deps.currentAction()
    if (action === 'stop' || action === 'restart') return
    const state = this.#deps.currentState()
    if (state !== 'running' && state !== 'booting') return
    const handle = this.#deps.runtimeHandle()
    if (!handle) return
    const alive = await handle.adapter.isAlive().catch(() => false)
    if (alive) return
    if (this.#deps.currentState() !== state) return
    await this.#externalGone()
  }

  async #externalGone(): Promise<void> {
    const handle = this.#deps.runtimeHandle()
    await handle?.adapter.cancelStart?.().catch(() => undefined)
    await this.#deps.closeSessions().catch(() => undefined)
    await this.#deps.disconnectAdb().catch(() => undefined)
    this.#deps.halt('实例已被外部关闭（pid 消失/端口关闭）')
    this.#deps.clearTransientErrors()
    this.#deps.emitStatus()
  }

  /** 停止（issue #83）：按状态与所有权分流，具体语义见类注释。 */
  async stop(options: { force?: boolean } = {}): Promise<void> {
    if (this.#deps.currentState() === 'stopped') return
    const runtimeStatus = await this.#deps.adapterStatus()
    this.#deps.cacheStatus(runtimeStatus)
    const owned = runtimeStatus?.owned ?? runtimeStatus?.adopted !== true
    if (this.#deps.currentState() === 'booting') {
      const handle = this.#deps.runtimeHandle()
      await withTimeout(
        handle?.adapter.cancelStart?.() ?? Promise.resolve(),
        this.#deps.interruptTimeoutMs ?? CANCEL_START_TIMEOUT_MS,
        () => new RuntimeError('取消启动超时', 'stop'),
      ).catch(() => undefined)
      await this.#deps.closeSessions().catch(() => undefined)
      await this.#deps.disconnectAdb().catch(() => undefined)
      this.#deps.halt(options.force === true ? '已停止' : '已停止（启动被取消）')
      this.#deps.emitStatus()
      return
    }
    if (!owned) {
      await this.#deps.closeSessions().catch(() => undefined)
      await this.#deps.disconnectAdb().catch(() => undefined)
      this.#deps.halt('已断开连接（实例由用户启动，未关闭）')
      this.#deps.emitStatus()
      return
    }
    await this.#deps.stopNow()
    this.#deps.emitStatus()
  }

  /** 卸载（issue #83）：总预算内完成；owned 先 stop（保存快照），adopted 只断开。 */
  async dispose(): Promise<void> {
    this.stopWatchdog()
    this.#deps.setDisposing(true)
    const deadline = this.#deps.now() + this.#deps.disposeBudgetMs
    const remaining = (): number => Math.max(1, deadline - this.#deps.now())
    const within = async (work: Promise<unknown>): Promise<unknown> =>
      Promise.race([work.catch(() => undefined), guardDelay(remaining())])
    if (this.#deps.currentState() === 'booting') {
      const handle = this.#deps.runtimeHandle()
      await within(Promise.resolve(handle?.adapter.cancelStart?.()).catch(() => undefined))
      await within(this.#deps.closeSessions())
      await within(this.#deps.disconnectAdb())
      this.#deps.halt('插件卸载：已取消启动')
      await within(this.#deps.disposeLifecycle())
      this.stopWatchdog()
      this.#deps.setDisposing(false)
      return
    }
    const status = (await within(
      Promise.race([
        this.#deps.adapterStatus(),
        guardDelay(Math.min(1_000, remaining())),
      ]),
    )) as RuntimeStatus | undefined
    if (status?.owned === true) {
      await within(this.#deps.stopNow('插件卸载：已停止手机实例'))
    } else {
      await within(this.#deps.closeSessions())
      await within(this.#deps.disconnectAdb())
    }
    await within(this.#deps.closeSessions())
    await within(this.#deps.disconnectAdb())
    await within(this.#deps.disposeLifecycle())
    this.stopWatchdog()
    this.#deps.setDisposing(false)
  }
}

