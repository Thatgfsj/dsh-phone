/**
 * Actionable empty states for the phone tab (issue #45).
 *
 * Before streaming, the body checks onboarding/Host availability (see gate.ts).
 * Pending/declined/unavailable must never leave a black canvas: the state shows
 * readable copy plus the shared onboarding card (pending can pick a runtime
 * right here, declined can re-enable). DSH exposes no public "open settings
 * section" API to third-party client plugins, so the card is embedded here and
 * the copy points at 设置 → 手机 as the equivalent place (issue #45 allows this).
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'
import { createOnboardingCard } from './onboarding.ts'
import type { ConfigApi, PhoneConfigView } from './settings-api.ts'

export type EmptyGate = 'pending' | 'declined' | 'unavailable'

/** Copy + primary action for one empty state (pure, unit-tested). */
export interface EmptyStateCopy {
  title: string
  body: string
  hint: string
  action: 'enable' | 'retry'
}

export function describeEmptyState(gate: EmptyGate, t: Translate, message?: string): EmptyStateCopy {
  switch (gate) {
    case 'pending':
      return {
        title: t('panel.empty.pendingTitle'),
        body: t('panel.empty.pendingBody'),
        hint: t('panel.empty.settingsHint'),
        action: 'enable',
      }
    case 'declined':
      return {
        title: t('panel.empty.declinedTitle'),
        body: t('panel.empty.declinedBody'),
        hint: t('panel.empty.settingsHint'),
        action: 'enable',
      }
    case 'unavailable':
      return {
        title: t('panel.empty.unavailableTitle'),
        body: t('panel.empty.unavailableBody', { message: message ?? '' }),
        hint: t('panel.empty.unavailableHint'),
        action: 'retry',
      }
  }
}

export interface EmptyStateDeps {
  React: typeof ReactNamespace
  t: Translate
}

export interface PanelEmptyStateProps {
  gate: EmptyGate
  config?: PhoneConfigView
  api: ConfigApi
  reload: () => Promise<PhoneConfigView | undefined>
  onConfig: (next: PhoneConfigView) => void
  onRetry: () => void
  errorMessage?: string
}

/** Build the empty-state component; it embeds the shared onboarding card. */
export function createPanelEmptyState(deps: EmptyStateDeps): ReactNamespace.ComponentType<PanelEmptyStateProps> {
  const { React, t } = deps
  const h = React.createElement
  const OnboardingCard = createOnboardingCard({ React, t })

  function PanelEmptyState(props: PanelEmptyStateProps): ReactNamespace.ReactElement {
    const { gate, config, api, reload, onConfig, onRetry, errorMessage } = props
    const [feedback, setFeedback] = React.useState<{ tone: 'ok' | 'error'; text: string }>()
    const copy = describeEmptyState(gate, t, errorMessage)
    const showCard = gate !== 'unavailable' && config !== undefined

    return h(
      'div',
      { className: 'dshp-empty', 'data-state': gate },
      h('div', { className: 'dshp-empty-title' }, copy.title),
      h('p', { className: 'dshp-hint' }, copy.body),
      h('p', { className: 'dshp-hint' }, copy.hint),
      feedback === undefined
        ? null
        : h(
            'p',
            { className: feedback.tone === 'ok' ? 'dshp-hint' : 'dshp-error' },
            feedback.text,
          ),
      showCard
        ? h(OnboardingCard, {
            api,
            config,
            reload,
            onConfig: (next: PhoneConfigView) => {
              setFeedback(undefined)
              onConfig(next)
            },
            onMessage: (text: string) => setFeedback({ tone: 'ok', text }),
            onError: (text: string | undefined) =>
              setFeedback(text === undefined ? undefined : { tone: 'error', text }),
          })
        : null,
      copy.action === 'retry'
        ? h(
            'div',
            { className: 'dshp-row' },
            h(
              'button',
              { type: 'button', className: 'dshp-button', onClick: onRetry },
              t('panel.empty.retry'),
            ),
          )
        : null,
    )
  }

  PanelEmptyState.displayName = 'DshPhonePanelEmptyState'
  return PanelEmptyState
}
