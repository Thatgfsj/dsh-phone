/**
 * Provisioning UI state machine + 1s poller (UI #66, API #65).
 *
 * Kept free of React so the whole lifecycle is unit-tested with fake timers:
 * probe on mount (done → auto-enable, running → resume polling), start on
 * button click, poll every second while running, stop on done/failed/user stop,
 * and surface a readable failure instead of throwing.
 */
import type { ProvisionApi, ProvisionStatus } from './provision-api.ts'
import { isProvisionUnsupported } from './provision-api.ts'

/** Seconds between status reads (issue #66: 1s). */
export const PROVISION_POLL_INTERVAL_MS = 1_000

export interface ProvisionView {
  /** False when the Host does not implement /provision (older build). */
  available: boolean
  active: boolean
  done: boolean
  failed: boolean
  status?: ProvisionStatus
  /** Read/start failure copy (not a job failure; job failures live in status.error). */
  error?: string
}

/** Derive the card state from the last status/failure. */
export function describeProvision(status?: ProvisionStatus, failure?: unknown): ProvisionView {
  if (status === undefined && failure !== undefined) {
    return { available: !isProvisionUnsupported(failure), active: false, done: false, failed: false }
  }
  const state = status?.state ?? 'idle'
  return {
    available: true,
    active: state === 'running',
    done: state === 'done',
    failed: state === 'failed',
    status,
  }
}

/** Done + still pending onboarding → write accepted automatically. */
export function shouldAutoAccept(view: ProvisionView, mode: 'pending' | 'accepted' | 'declined'): boolean {
  return view.done && mode === 'pending'
}

export interface ProvisionPollerOptions {
  api: ProvisionApi
  onStatus: (status: ProvisionStatus) => void
  onFailure: (error: unknown) => void
  intervalMs?: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Start/probe/poll the Host provisioning job; polling only while running. */
export class ProvisionPoller {
  #running = false
  #timer: unknown
  #disposed = false
  readonly #options: ProvisionPollerOptions
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #intervalMs: number

  constructor(options: ProvisionPollerOptions) {
    this.#options = options
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.#intervalMs = options.intervalMs ?? PROVISION_POLL_INTERVAL_MS
  }

  get polling(): boolean {
    return this.#running
  }

  /** Start a job (user click) and poll until it settles. */
  async start(): Promise<void> {
    if (this.#disposed) return
    try {
      const status = await this.#options.api.start('emulator')
      this.#options.onStatus(status)
      if (status.state === 'running') this.#beginPolling()
    } catch (failure) {
      this.#options.onFailure(failure)
    }
  }

  /** Read once (mount/Installed detection) without starting a job. */
  async probe(): Promise<ProvisionStatus | undefined> {
    if (this.#disposed) return undefined
    try {
      const status = await this.#options.api.get()
      this.#options.onStatus(status)
      if (status.state === 'running') this.#beginPolling()
      return status
    } catch (failure) {
      this.#options.onFailure(failure)
      return undefined
    }
  }

  /** Re-read now (retry button) and continue polling if the job is running. */
  async refresh(): Promise<void> {
    await this.probe()
  }

  /** Stop the UI poller only; the Host job (if any) keeps running. */
  stopPolling(): void {
    this.#running = false
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = undefined
  }

  dispose(): void {
    this.#disposed = true
    this.stopPolling()
  }

  #beginPolling(): void {
    if (this.#running || this.#disposed) return
    this.#running = true
    this.#schedule()
  }

  #schedule(): void {
    this.#timer = this.#setTimer(() => {
      void this.#tick()
    }, this.#intervalMs)
  }

  async #tick(): Promise<void> {
    if (!this.#running || this.#disposed) return
    try {
      const status = await this.#options.api.get()
      this.#options.onStatus(status)
      if (status.state !== 'running') {
        this.stopPolling()
        return
      }
    } catch (failure) {
      this.stopPolling()
      this.#options.onFailure(failure)
      return
    }
    if (this.#running) this.#schedule()
  }
}
