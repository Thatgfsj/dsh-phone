/**
 * Best-effort auto-open of the phone tab on plugin load (issue #45, #47).
 *
 * The right Sidebar only accepts `openTab` once a Session is on screen and its
 * store has been adopted; plugins load before that. So we poll gently for up to
 * 10 seconds and then give up silently. Nothing here may block the plugin or
 * raise: the header button/settings page remain the explicit paths.
 *
 * Every onboarding state except declined opens the tab (#47): on pending the
 * panel itself asks for consent, so first-time users see the phone in the
 * sidebar without hunting for the settings page. Declined stays closed; the
 * header icon is still a manual way in.
 */
export interface AutoOpenConfig {
  onboarding?: { status: string }
}

export interface AutoOpenOptions {
  /** Reads the Host config once; rejects when the Host is unreachable. */
  getConfig: () => Promise<AutoOpenConfig>
  /** `ctx.sidebarRight.openTab(kind)`; throws while no Session is on screen. */
  openTab: () => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Total retry window. */
  timeoutMs?: number
  /** Delay between attempts. */
  pollMs?: number
}

export type AutoOpenResult = 'opened' | 'skipped' | 'timeout' | 'unavailable'

export const AUTO_OPEN_TIMEOUT_MS = 10_000
export const AUTO_OPEN_POLL_MS = 500

/**
 * Open the phone tab unless onboarding was declined, retrying while the shell is
 * not ready yet.
 * @param options - config reader, opener and injectable clock/sleep.
 * @returns why it stopped (never throws).
 */
export async function maybeAutoOpenPhone(options: AutoOpenOptions): Promise<AutoOpenResult> {
  const timeoutMs = options.timeoutMs ?? AUTO_OPEN_TIMEOUT_MS
  const pollMs = options.pollMs ?? AUTO_OPEN_POLL_MS
  let config: AutoOpenConfig
  try {
    config = await options.getConfig()
  } catch {
    return 'unavailable'
  }
  // A Host without the onboarding field (older build) counts as accepted.
  const status = config.onboarding?.status ?? 'accepted'
  // Pending also opens (#47): the panel renders the consent card itself.
  if (status === 'declined') return 'skipped'
  const deadline = options.now() + timeoutMs
  for (;;) {
    try {
      options.openTab()
      return 'opened'
    } catch {
      if (options.now() >= deadline) return 'timeout'
      await options.sleep(pollMs)
    }
  }
}
