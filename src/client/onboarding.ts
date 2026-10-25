/**
 * First-run onboarding card shown in Settings → Phone (issue #31) and, since
 * #66, inside the right-Sidebar panel. Pending delegates its body to the
 * one-click provisioning card; accepted/declined keep the short status card.
 *
 * Pure decision/write helpers live in onboarding-flow.ts (re-exported here so
 * existing importers keep working); the one-click UI lives in
 * provision-card.ts / provision-views.ts (host API #65).
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'
import { createProvisionCard } from './provision-card.ts'
import type { ProvisionApi } from './provision-api.ts'
import {
  describeOnboarding,
  choiceLabelKey,
  declineOnboarding,
  reopenOnboarding,
} from './onboarding-flow.ts'
import type { ConfigApi, PhoneConfigView } from './settings-api.ts'
import { messageOf } from './settings-api.ts'

export * from './onboarding-flow.ts'

type Reload = () => Promise<PhoneConfigView | undefined>
type WriteApi = Pick<ConfigApi, 'writeConfig'>

export interface OnboardingCardProps {
  api: WriteApi
  provisionApi: ProvisionApi
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

/** Build the onboarding card component for the current locale. */
export function createOnboardingCard(deps: OnboardingCardDeps): ReactNamespace.ComponentType<OnboardingCardProps> {
  const { React, t } = deps
  const h = React.createElement
  const ProvisionCard = createProvisionCard({ React, t }).card

  function CardButton(props: {
    label: string
    busy: boolean
    primary?: boolean
    onClick: () => void
  }): ReactNamespace.ReactElement {
    return h(
      'button',
      {
        type: 'button',
        className: 'dshp-button',
        'data-variant': props.primary ? 'primary' : undefined,
        disabled: props.busy,
        onClick: props.onClick,
      },
      props.label,
    )
  }

  function OnboardingCard(props: OnboardingCardProps): ReactNamespace.ReactElement {
    const { api, config, reload, onConfig, onMessage, onError } = props
    const [busy, setBusy] = React.useState(false)
    const mode = describeOnboarding(config)

    const run = async (action: () => Promise<{ value: PhoneConfigView; retried: boolean }>): Promise<void> => {
      setBusy(true)
      onError(undefined)
      try {
        const outcome = await action()
        onConfig(outcome.value)
        onMessage(outcome.retried ? t('onboarding.conflict') : t('onboarding.saved'))
      } catch (failure) {
        onError(t('onboarding.failed', { message: messageOf(failure) }))
      } finally {
        setBusy(false)
      }
    }

    if (mode.mode === 'declined') {
      return h(
        'section',
        { className: 'dshp-card' },
        h('h4', { className: 'dshp-card-title' }, t('onboarding.declined')),
        h('p', { className: 'dshp-text dshp-text--left dshp-hint' }, t('onboarding.declinedHint')),
        h(
          'div',
          { className: 'dshp-actions' },
          h(CardButton, {
            label: busy ? t('onboarding.busy') : t('onboarding.reopen'),
            busy,
            primary: true,
            onClick: () => void run(() => reopenOnboarding(api, config.revision, reload)),
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
          { className: 'dshp-text dshp-text--left dshp-hint' },
          t('onboarding.accepted', { choice: t(choiceLabelKey(mode.choice)) }),
        ),
        h(
          'div',
          { className: 'dshp-actions' },
          h(CardButton, {
            label: busy ? t('onboarding.busy') : t('onboarding.reselect'),
            busy,
            onClick: () => void run(() => reopenOnboarding(api, config.revision, reload)),
          }),
          h(CardButton, {
            label: t('onboarding.choice.decline'),
            busy,
            onClick: () => void run(() => declineOnboarding(api, config.revision, reload)),
          }),
        ),
      )
    }

    return h(ProvisionCard, {
      api,
      provisionApi: props.provisionApi,
      config,
      reload,
      onConfig,
      onMessage,
      onError,
    })
  }

  OnboardingCard.displayName = 'DshPhoneOnboardingCard'
  return OnboardingCard
}
