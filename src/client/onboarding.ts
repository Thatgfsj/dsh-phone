/**
 * First-run onboarding card shown inside Settings → Phone (issue #31).
 *
 * The Host guard (issue #30) exposes:
 * - `GET /dsh-phone/api/config` → `onboarding: { status, choice }`;
 * - `POST /dsh-phone/api/config` accepts `onboarding.status` / `onboarding.choice`;
 * - `GET /status` answers 200 + `{ok:false, error:{code:'E_ONBOARDING_REQUIRED'}}`
 *   while pending — settings-api.readRunStatus treats that as "no status".
 *
 * The card only *records the user's decision* and shows install hints: the
 * plugin never installs software, so every command is displayed for the user to
 * run in their own terminal (SPEC §6.4).
 *
 * Flow helpers are pure (api + revision + reload in, config out) so the write
 * sequencing and the 409 retry are unit-tested without rendering.
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'
import { ONBOARDING_INSTALL_COMMANDS } from '../runtime/install-guide.ts'
import { messageOf, writeWithConflictRetry, type ConfigApi, type OnboardingChoice, type PhoneConfigView } from './settings-api.ts'

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
export function describeOnboarding(
  config: Pick<PhoneConfigView, 'onboarding'> | undefined,
): OnboardingMode {
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

/** Install hints are informational; the plugin never runs them.
 * 数据源：src/runtime/install-guide.ts（与 detect hints / onboarding 载荷共用，issue #38）。 */
export const INSTALL_COMMANDS = ONBOARDING_INSTALL_COMMANDS

export interface OnboardingCardProps {
  api: WriteApi
  config: PhoneConfigView
  reload: Reload
  onConfig: (next: PhoneConfigView) => void
  onMessage: (message: string) => void
  onError: (message: string | undefined) => void
}

export interface OnboardingCardDeps {
  React: typeof ReactNamespace
  t: Translate
}

const CHOICES: readonly { choice: Exclude<OnboardingChoice, ''>; label: string; hint: string }[] = [
  { choice: 'emulator', label: 'onboarding.choice.emulator', hint: 'onboarding.choice.emulatorNote' },
  { choice: 'redroid', label: 'onboarding.choice.redroid', hint: 'onboarding.choice.redroidNote' },
  { choice: 'attach', label: 'onboarding.choice.attach', hint: 'onboarding.choice.attachNote' },
]

/** Build the onboarding card component for the current locale. */
export function createOnboardingCard(deps: OnboardingCardDeps): ReactNamespace.ComponentType<OnboardingCardProps> {
  const { React, t } = deps
  const h = React.createElement

  function CardButton(props: {
    label: string
    busy: boolean
    primary?: boolean
    disabled: boolean
    onClick: () => void
  }): ReactNamespace.ReactElement {
    return h(
      'button',
      {
        type: 'button',
        className: 'dshp-button',
        'data-variant': props.primary ? 'primary' : undefined,
        disabled: props.disabled || props.busy,
        onClick: props.onClick,
      },
      props.label,
    )
  }

  function OnboardingCard(props: OnboardingCardProps): ReactNamespace.ReactElement {
    const { api, config, reload, onConfig, onMessage, onError } = props
    const [busy, setBusy] = React.useState<string | undefined>(undefined)
    const mode = describeOnboarding(config)

    const run = async (label: string, action: () => Promise<OnboardingWriteResult>): Promise<void> => {
      setBusy(label)
      onError(undefined)
      try {
        const outcome = await action()
        onConfig(outcome.value)
        onMessage(outcome.retried ? t('onboarding.conflict') : t('onboarding.saved'))
      } catch (failure) {
        onError(t('onboarding.failed', { message: messageOf(failure) }))
      } finally {
        setBusy(undefined)
      }
    }

    const accept = (choice: Exclude<OnboardingChoice, ''>): Promise<void> =>
      run(choice, () => acceptOnboarding(api, choice, config.revision, reload))
    const decline = (): Promise<void> =>
      run('decline', () => declineOnboarding(api, config.revision, reload))
    const reopen = (): Promise<void> => run('reopen', () => reopenOnboarding(api, config.revision, reload))

    if (mode.mode === 'declined') {
      return h(
        'section',
        { className: 'dshp-card' },
        h('h4', { className: 'dshp-card-title' }, t('onboarding.declined')),
        h('p', { className: 'dshp-hint' }, t('onboarding.declinedHint')),
        h(
          'div',
          { className: 'dshp-row' },
          h(CardButton, {
            label: busy === 'reopen' ? t('onboarding.busy') : t('onboarding.reopen'),
            busy: busy !== undefined,
            primary: true,
            disabled: false,
            onClick: () => void reopen(),
          }),
        ),
      )
    }

    if (mode.mode === 'accepted') {
      return h(
        'section',
        { className: 'dshp-card' },
        h(
          'p',
          { className: 'dshp-hint' },
          t('onboarding.accepted', { choice: t(choiceLabelKey(mode.choice)) }),
        ),
        h(
          'div',
          { className: 'dshp-row' },
          h(CardButton, {
            label: busy === 'reopen' ? t('onboarding.busy') : t('onboarding.reselect'),
            busy: busy !== undefined,
            disabled: false,
            onClick: () => void reopen(),
          }),
        ),
      )
    }

    return h(
      'section',
      { className: 'dshp-card', 'data-state': 'pending' },
      h('h4', { className: 'dshp-card-title' }, t('onboarding.title')),
      h('p', { className: 'dshp-hint' }, t('onboarding.description')),
      h('p', { className: 'dshp-hint' }, t('onboarding.installNote')),
      h(
        'div',
        { className: 'dshp-options' },
        ...CHOICES.map((item) =>
          h(
            'div',
            { className: 'dshp-option', key: item.choice },
            h(CardButton, {
              label: busy === item.choice ? t('onboarding.busy') : t(item.label),
              busy: busy !== undefined,
              disabled: false,
              onClick: () => void accept(item.choice),
            }),
            h('p', { className: 'dshp-hint' }, t(item.hint)),
            item.choice === 'emulator'
              ? h(
                  'div',
                  null,
                  h('code', { className: 'dshp-command' }, INSTALL_COMMANDS.emulator),
                  h('p', { className: 'dshp-hint' }, t('onboarding.choice.emulatorSize')),
                )
              : null,
            item.choice === 'redroid'
              ? h(
                  'div',
                  null,
                  h('code', { className: 'dshp-command' }, INSTALL_COMMANDS.redroid),
                  h('p', { className: 'dshp-hint' }, t('onboarding.choice.redroidSize')),
                )
              : null,
          ),
        ),
      ),
      h(
        'div',
        { className: 'dshp-row' },
        h(CardButton, {
          label: busy === 'decline' ? t('onboarding.busy') : t('onboarding.choice.decline'),
          busy: busy !== undefined,
          disabled: false,
          onClick: () => void decline(),
        }),
      ),
    )
  }

  OnboardingCard.displayName = 'DshPhoneOnboardingCard'
  return OnboardingCard
}
