/**
 * One-click "prepare and enable" UI (issue #66) on top of the provisioning API
 * (#65). Two surfaces share one state machine:
 * - `createProvisionCard`: the pending onboarding card body (primary one-click,
 *   secondary "use existing"/"not now", collapsible manual commands);
 * - `createProvisionEntry`: the accepted/settings entry (status + prepare button).
 *
 * Every write still goes through the onboarding flow helpers (revision + 409
 * retry). A `done` probe auto-enables onboarding without re-downloading.
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'
import { acceptOnboarding, declineOnboarding, describeOnboarding } from './onboarding-flow.ts'
import { createProvisionViews } from './provision-views.ts'
import {
  describeProvision,
  shouldAutoAccept,
  ProvisionPoller,
} from './provision-flow.ts'
import type { ProvisionView } from './provision-flow.ts'
import type { ProvisionApi, ProvisionStatus } from './provision-api.ts'
import { provisionStepKey, recentLog } from './provision-api.ts'
import { messageOf } from './settings-api.ts'
import type { ConfigApi, PhoneConfigView } from './settings-api.ts'

export interface ProvisionCardProps {
  api: Pick<ConfigApi, 'writeConfig'>
  provisionApi: ProvisionApi
  config: PhoneConfigView
  reload: () => Promise<PhoneConfigView | undefined>
  onConfig: (next: PhoneConfigView) => void
  onMessage: (message: string) => void
  onError: (message: string | undefined) => void
}

export interface ProvisionCardDeps {
  React: typeof ReactNamespace
  t: Translate
}

type Reload = () => Promise<PhoneConfigView | undefined>
type WriteApi = Pick<ConfigApi, 'writeConfig'>

interface Flow {
  view: ProvisionView
  busy: boolean
  manualOpen: boolean
  logs: string[]
  stepText: string
  percent: number
  onStart: () => void
  onStop: () => void
  onManual: () => void
  onAccept: (choice: 'emulator' | 'redroid' | 'attach') => void
  onDecline: () => void
}

/** Build the provisioning card pair for the current locale. */
export function createProvisionCard(deps: ProvisionCardDeps): {
  card: ReactNamespace.ComponentType<ProvisionCardProps>
  entry: ReactNamespace.ComponentType<ProvisionCardProps>
} {
  const { React, t } = deps
  const h = React.createElement
  const views = createProvisionViews({ React, t })

  function useFlow(props: ProvisionCardProps): Flow {
    const { api, provisionApi, config, reload, onConfig, onMessage, onError } = props
    const [status, setStatus] = React.useState<ProvisionStatus>()
    const [failure, setFailure] = React.useState<unknown>()
    const [busy, setBusy] = React.useState(false)
    const [manualOpen, setManualOpen] = React.useState(false)
    const pollerRef = React.useRef<ProvisionPoller | null>(null)
    const autoRef = React.useRef(false)
    const aliveRef = React.useRef(true)

    const applyConfig = React.useCallback(
      (next: PhoneConfigView, retried: boolean): void => {
        onConfig(next)
        onMessage(retried ? t('onboarding.conflict') : t('onboarding.saved'))
      },
      [onConfig, onMessage, t],
    )

    const accept = React.useCallback(
      async (choice: 'emulator' | 'redroid' | 'attach'): Promise<void> => {
        setBusy(true)
        onError(undefined)
        try {
          const outcome = await acceptOnboarding(api, choice, config.revision, reload)
          if (aliveRef.current) applyConfig(outcome.value, outcome.retried)
        } catch (error) {
          if (aliveRef.current) onError(t('onboarding.failed', { message: messageOf(error) }))
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      },
      [api, applyConfig, config.revision, onError, reload, t],
    )

    React.useEffect(() => {
      aliveRef.current = true
      const poller = new ProvisionPoller({
        api: provisionApi,
        onStatus: (next) => {
          if (aliveRef.current) {
            setStatus(next)
            setFailure(undefined)
          }
        },
        onFailure: (error) => {
          if (aliveRef.current) setFailure(error)
        },
      })
      pollerRef.current = poller
      void (async () => {
        const probed = await poller.probe()
        const view = describeProvision(probed)
        if (probed !== undefined && shouldAutoAccept(view, describeOnboarding(config).mode) && !autoRef.current) {
          autoRef.current = true
          await accept('emulator')
        }
      })()
      return () => {
        aliveRef.current = false
        poller.dispose()
        pollerRef.current = null
      }
    }, [])

    const view = describeProvision(status, failure)
    const logs = status === undefined ? [] : recentLog(status.log, 5)
    const stepText = status === undefined ? t('provision.step.idle') : t(provisionStepKey(status.step))
    const percent = status?.percent ?? 0

    const onStart = (): void => {
      setBusy(true)
      onError(undefined)
      void pollerRef.current?.start().finally(() => {
        if (aliveRef.current) setBusy(false)
      })
    }
    const onRetry = (): void => {
      setFailure(undefined)
      onStart()
    }
    const onStop = (): void => {
      pollerRef.current?.stopPolling()
      onMessage(t('provision.stopped'))
    }
    const onManual = (): void => setManualOpen((open) => !open)
    const onDecline = (): void => {
      setBusy(true)
      onError(undefined)
      void declineOnboarding(api, config.revision, reload)
        .then((outcome) => {
          if (aliveRef.current) applyConfig(outcome.value, outcome.retried)
        })
        .catch((error: unknown) => {
          if (aliveRef.current) onError(t('onboarding.failed', { message: messageOf(error) }))
        })
        .finally(() => {
          if (aliveRef.current) setBusy(false)
        })
    }

    return {
      view,
      busy,
      manualOpen,
      logs,
      stepText,
      percent,
      onStart,
      onStop,
      onManual,
      onAccept: (choice) => void accept(choice),
      onDecline,
    }
  }

  function ProvisionCard(props: ProvisionCardProps): ReactNamespace.ReactElement {
    const flow = useFlow(props)
    const unsupported = !flow.view.available
    return h(
      'section',
      { className: 'dshp-card', 'data-state': 'pending' },
      h('h4', { className: 'dshp-card-title' }, t('onboarding.title')),
      h('p', { className: 'dshp-text dshp-text--left dshp-hint' }, t('onboarding.description')),
      h('p', { className: 'dshp-text dshp-text--left dshp-hint' }, t('onboarding.installNote')),
      unsupported
        ? h('p', { className: 'dshp-text dshp-text--left dshp-hint' }, t('provision.unsupported'))
        : h(
            'button',
            {
              type: 'button',
              className: 'dshp-button',
              'data-variant': 'primary',
              disabled: flow.busy || flow.view.active,
              onClick: flow.onStart,
            },
            flow.view.active ? t('provision.preparing') : t('provision.start'),
          ),
      flow.view.active || flow.view.failed ? views.renderProgress(flow) : null,
      h(
        'div',
        { className: 'dshp-actions' },
        h(
          'button',
          { type: 'button', className: 'dshp-button', disabled: flow.busy, onClick: () => flow.onAccept('attach') },
          t('onboarding.choice.attach'),
        ),
        h(
          'button',
          { type: 'button', className: 'dshp-button', disabled: flow.busy, onClick: flow.onDecline },
          t('onboarding.choice.decline'),
        ),
        h('button', { type: 'button', className: 'dshp-button', onClick: flow.onManual }, t('onboarding.manual')),
      ),
      flow.manualOpen ? views.renderManual(flow, true) : null,
    )
  }

  function ProvisionEntry(props: ProvisionCardProps): ReactNamespace.ReactElement {
    const flow = useFlow(props)
    const statusText = flow.view.done
      ? t('provision.ready')
      : flow.view.active
        ? t('provision.preparing')
        : flow.view.failed
          ? t('provision.failed')
          : t('provision.idle')
    return h(
      'section',
      { className: 'dshp-card' },
      h('h4', { className: 'dshp-card-title' }, t('provision.title')),
      h('p', { className: 'dshp-text dshp-text--left dshp-hint' }, statusText),
      !flow.view.done && flow.view.available
        ? h(
            'button',
            {
              type: 'button',
              className: 'dshp-button',
              'data-variant': 'primary',
              disabled: flow.busy || flow.view.active,
              onClick: flow.onStart,
            },
            flow.view.active ? t('provision.preparing') : t('provision.start'),
          )
        : null,
      !flow.view.available
        ? h('p', { className: 'dshp-text dshp-text--left dshp-hint' }, t('provision.unsupported'))
        : null,
      flow.view.active || flow.view.failed ? views.renderProgress(flow) : null,
      h(
        'div',
        { className: 'dshp-actions' },
        h('button', { type: 'button', className: 'dshp-button', onClick: flow.onManual }, t('onboarding.manual')),
      ),
      flow.manualOpen ? views.renderManual(flow, false) : null,
    )
  }

  ProvisionCard.displayName = 'DshPhoneProvisionCard'
  ProvisionEntry.displayName = 'DshPhoneProvisionEntry'
  return { card: ProvisionCard, entry: ProvisionEntry }
}
