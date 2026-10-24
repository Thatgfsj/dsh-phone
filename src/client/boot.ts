/**
 * Booting progress for the phone panel (issue #39 item 4).
 *
 * `PhoneStatus.bootMs` is the elapsed boot time while `state === 'booting'`
 * (src/phone/state.ts). The stream's `state` frame may carry it too; when it
 * does not, the panel polls `GET /dsh-phone/api/status` once per second — only
 * while the panel is visible and the instance is booting (architecture §7).
 * ready/running stops the poller. Everything here is injectable (clock/timers/
 * status reader) so the poll lifecycle is unit-tested without a browser.
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'
import type { PhoneStatusView } from './settings-api.ts'

/** Cold-boot ceiling used for the progress bar and the "slow" wording. */
export const BOOT_TIMEOUT_MS = 120_000
/** Poll cadence while booting (architecture §7: 1s). */
export const BOOT_POLL_INTERVAL_MS = 1_000

export interface BootProgress {
  /** Elapsed boot time reported by the Host. */
  bootMs: number
  /** Elapsed seconds, for copy like "已等待 {seconds}s". */
  seconds: number
  /** 0-100 progress against {@link BOOT_TIMEOUT_MS}. */
  percent: number
  /** i18n key describing the current boot phase. */
  phaseKey: string
  /** True once the nominal ceiling has been reached (not an error by itself). */
  timedOut: boolean
}

/**
 * Turn the Host boot counter into display copy + bar progress.
 * @param bootMs - elapsed milliseconds (clamped to >= 0).
 * @param timeoutMs - ceiling for the percentage/wording.
 */
export function describeBootProgress(bootMs: number, timeoutMs: number = BOOT_TIMEOUT_MS): BootProgress {
  const safeBootMs = Number.isFinite(bootMs) ? Math.max(0, Math.floor(bootMs)) : 0
  const ceiling = timeoutMs > 0 ? timeoutMs : BOOT_TIMEOUT_MS
  const percent = Math.min(100, Math.round((safeBootMs / ceiling) * 100))
  let phaseKey = 'panel.boot.phase.starting'
  if (safeBootMs >= 90_000) phaseKey = 'panel.boot.phase.slow'
  else if (safeBootMs >= 45_000) phaseKey = 'panel.boot.phase.firstBoot'
  else if (safeBootMs >= 15_000) phaseKey = 'panel.boot.phase.warming'
  return {
    bootMs: safeBootMs,
    seconds: Math.floor(safeBootMs / 1000),
    percent,
    phaseKey,
    timedOut: safeBootMs >= ceiling,
  }
}

/** Minimal status shape the poller needs (subset of PhoneStatusView). */
export interface BootStatus {
  state: string
  bootMs?: number
}

export interface BootStatusPollerOptions {
  /** One `GET /status` read; may reject transiently while the Host boots. */
  getStatus: () => Promise<BootStatus>
  /** Called with progress while booting, and `undefined` once booting ends. */
  onProgress: (progress: BootProgress | undefined) => void
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  intervalMs?: number
  now?: () => number
  timeoutMs?: number
}

/**
 * Poll `GET /status` once per second while booting.
 *
 * - `start()` is idempotent; `stop()` cancels a pending tick.
 * - A status read failure is swallowed and retried (the Host may still be
 *   coming up); only a non-booting state ends the poller.
 */
export class BootStatusPoller {
  #running = false
  #timer: unknown
  #startedAt = 0
  readonly #options: BootStatusPollerOptions
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #now: () => number
  readonly #intervalMs: number
  readonly #timeoutMs: number

  constructor(options: BootStatusPollerOptions) {
    this.#options = options
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.#now = options.now ?? (() => Date.now())
    this.#intervalMs = options.intervalMs ?? BOOT_POLL_INTERVAL_MS
    this.#timeoutMs = options.timeoutMs ?? BOOT_TIMEOUT_MS
  }

  get running(): boolean {
    return this.#running
  }

  /** Begin polling; no-op when already running. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#startedAt = this.#now()
    void this.#tick()
  }

  /** Cancel the loop and the pending timer. No more callbacks after this. */
  stop(): void {
    this.#running = false
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = undefined
  }

  async #tick(): Promise<void> {
    if (!this.#running) return
    let status: BootStatus | undefined
    try {
      status = await this.#options.getStatus()
    } catch {
      status = undefined // transient: keep the loop alive while booting
    }
    if (!this.#running) return
    if (status !== undefined && status.state !== 'booting') {
      this.#options.onProgress(undefined)
      this.stop()
      return
    }
    const fallbackMs = this.#now() - this.#startedAt
    const bootMs = status?.bootMs ?? fallbackMs
    this.#options.onProgress(describeBootProgress(bootMs, this.#timeoutMs))
    this.#timer = this.#setTimer(() => {
      void this.#tick()
    }, this.#intervalMs)
  }
}

/** Read `GET /status` as a boot status; typing helper for the panel wiring. */
export function toBootStatus(status: Pick<PhoneStatusView, 'state' | 'bootMs'>): BootStatus {
  return status.bootMs === undefined ? { state: status.state } : { state: status.state, bootMs: status.bootMs }
}


export interface BootIndicatorDeps {
  React: typeof ReactNamespace
  t: Translate
}

export interface BootIndicatorProps {
  progress: BootProgress
}

/**
 * Badge + overlay for the booting state. Kept in this module (not panel-view.ts)
 * so the panel body stays within the 300-line target.
 */
export function createBootIndicator(deps: BootIndicatorDeps): {
  badge: ReactNamespace.ComponentType<BootIndicatorProps>
  overlay: ReactNamespace.ComponentType<BootIndicatorProps>
} {
  const { React, t } = deps
  const h = React.createElement

  function BootBadge(props: BootIndicatorProps): ReactNamespace.ReactElement {
    return h(
      'span',
      {
        className: 'dshp-badge',
        'data-tone': props.progress.timedOut ? 'warn' : 'neutral',
      },
      t('panel.boot.progress', { seconds: props.progress.seconds }),
    )
  }

  function BootOverlay(props: BootIndicatorProps): ReactNamespace.ReactElement {
    return h(
      'div',
      { className: 'dshp-boot', 'data-state': 'booting' },
      h('div', null, t(props.progress.phaseKey)),
      h(
        'div',
        { className: 'dshp-progress' },
        h('div', {
          className: 'dshp-progress-bar',
          style: { width: props.progress.percent + '%' },
        }),
      ),
      h(
        'span',
        { className: 'dshp-hint' },
        t('panel.boot.placeholder') + ' · ' + t('panel.boot.percent', { percent: props.progress.percent }),
      ),
    )
  }

  return { badge: BootBadge, overlay: BootOverlay }
}
