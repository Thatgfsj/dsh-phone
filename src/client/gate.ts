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
