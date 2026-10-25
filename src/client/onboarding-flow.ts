/**
 * Onboarding decision helpers (issues #31/#66), split from the card so the
 * pure write sequencing and the provisioning card can share them without a
 * module cycle.
 *
 * Contract (docs/protocol.md §1, host #52): GET /config carries
 * `onboarding: {status, choice}`; POST /config accepts onboarding.status /
 * onboarding.choice; every write goes through `writeWithConflictRetry` (409:
 * refresh revision, retry once).
 */
import { writeWithConflictRetry, type ConfigApi, type OnboardingChoice, type PhoneConfigView } from './settings-api.ts'

/** Which surface the settings page shows for a config. */
export interface OnboardingMode {
  mode: 'pending' | 'accepted' | 'declined'
  choice: OnboardingChoice
  /** Accepted: the one-liner/resolved/run-state area is meaningful. */
  showSetup: boolean
}

/**
 * Derive the card mode. A Host without the onboarding field (older build) is
 * treated as accepted so existing installs never see a blocking prompt.
 */
export function describeOnboarding(config: Pick<PhoneConfigView, 'onboarding'> | undefined): OnboardingMode {
  const onboarding = config?.onboarding
  if (onboarding === undefined) return { mode: 'accepted', choice: '', showSetup: true }
  return {
    mode: onboarding.status,
    choice: onboarding.choice,
    showSetup: onboarding.status === 'accepted',
  }
}

/** i18n key for a chosen runtime (also used by the accepted summary row). */
export function choiceLabelKey(choice: OnboardingChoice): string {
  switch (choice) {
    case 'emulator':
      return 'onboarding.choiceLabel.emulator'
    case 'redroid':
      return 'onboarding.choiceLabel.redroid'
    case 'attach':
      return 'onboarding.choiceLabel.attach'
    default:
      return 'onboarding.choiceLabel.none'
  }
}

type WriteApi = Pick<ConfigApi, 'writeConfig'>
type Reload = () => Promise<PhoneConfigView | undefined>

export interface OnboardingWriteResult {
  value: PhoneConfigView
  retried: boolean
}

interface WriteEntry {
  path: string[]
  value: unknown
}

/** Write several onboarding keys in order, carrying the revision forward. */
async function writeSequence(
  api: WriteApi,
  entries: readonly WriteEntry[],
  revision: number,
  reload: Reload,
): Promise<OnboardingWriteResult> {
  let current = revision
  let retried = false
  let value: PhoneConfigView | undefined
  for (const entry of entries) {
    const outcome = await writeWithConflictRetry(api, entry.path, entry.value, current, reload)
    current = outcome.value.revision
    retried = retried || outcome.retried
    value = outcome.value
  }
  if (value === undefined) throw new Error('onboarding write sequence is empty')
  return { value, retried }
}

/** Accept onboarding with a runtime choice (choice first, then status). */
export async function acceptOnboarding(
  api: WriteApi,
  choice: Exclude<OnboardingChoice, ''>,
  revision: number,
  reload: Reload,
): Promise<OnboardingWriteResult> {
  return writeSequence(
    api,
    [
      { path: ['onboarding', 'choice'], value: choice },
      { path: ['onboarding', 'status'], value: 'accepted' },
    ],
    revision,
    reload,
  )
}

/** Decline onboarding ("not now"); the user can reopen it later. */
export async function declineOnboarding(
  api: WriteApi,
  revision: number,
  reload: Reload,
): Promise<OnboardingWriteResult> {
  return writeSequence(api, [{ path: ['onboarding', 'status'], value: 'declined' }], revision, reload)
}

/** Reopen the prompt from accepted/declined (status only; choice is kept). */
export async function reopenOnboarding(
  api: WriteApi,
  revision: number,
  reload: Reload,
): Promise<OnboardingWriteResult> {
  return writeSequence(api, [{ path: ['onboarding', 'status'], value: 'pending' }], revision, reload)
}

/** Install hints are informational; only the explicit one-click path installs.
 * 数据源：src/runtime/install-guide.ts（与 detect hints / onboarding 载荷共用，issue #38）。 */
export { ONBOARDING_INSTALL_COMMANDS as INSTALL_COMMANDS } from '../runtime/install-guide.ts'
