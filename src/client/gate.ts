/**
 * Panel gate: what the phone tab body should show before it can stream.
 *
 * Onboarding pending/declined and an unreachable Host must not leave a black
 * canvas or an endless spinner (issue #45). Kept pure so the three empty states
 * are unit-tested without rendering React.
 */
import type { PhoneConfigView } from './settings-api.ts'

export type PanelGate = 'checking' | 'ready' | 'pending' | 'declined' | 'unavailable'

export interface PanelGateInput {
  /** Loaded config; `undefined` while loading or after a failure. */
  config?: PhoneConfigView
  /** Config read failure, if any. */
  error?: unknown
}

/**
 * Decide which shell the body renders.
 * - no config/no error → still checking;
 * - error → unavailable;
 * - onboarding missing (older Host) or accepted → ready;
 * - pending/declined → the matching empty state.
 */
export function describePanelGate(input: PanelGateInput): PanelGate {
  if (input.error !== undefined) return 'unavailable'
  const config = input.config
  if (config === undefined) return 'checking'
  const status = config.onboarding?.status
  if (status === 'pending') return 'pending'
  if (status === 'declined') return 'declined'
  return 'ready'
}

/** Attempts before the panel shows the unavailable state. */
export const PANEL_CONFIG_ATTEMPTS = 4
/** Delay between initial config read attempts (Host boot race, issue #47). */
export const PANEL_CONFIG_RETRY_MS = 400

export interface PanelConfigLoadOptions {
  getConfig: () => Promise<PhoneConfigView>
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  delayMs?: number
}

export interface PanelConfigLoadResult {
  config?: PhoneConfigView
  error?: unknown
}

/**
 * Read the panel config, retrying a few times so a Host that is still booting
 * does not flash an unavailable/connection error on the panel first frame
 * (issue #47). Never throws.
 */
export async function loadPanelConfig(options: PanelConfigLoadOptions): Promise<PanelConfigLoadResult> {
  const attempts = Math.max(1, options.attempts ?? PANEL_CONFIG_ATTEMPTS)
  const delayMs = options.delayMs ?? PANEL_CONFIG_RETRY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return { config: await options.getConfig() }
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await sleep(delayMs)
    }
  }
  return { error: lastError }
}
