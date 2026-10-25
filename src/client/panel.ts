/**
 * Phone tab body (issue #45).
 *
 * Before mounting the streaming view, read `GET /dsh-phone/api/config` and gate
 * on onboarding/Host state (gate.ts). Pending/declined/unavailable render an
 * actionable empty state instead of a black canvas; accepting onboarding inside
 * that card flips the gate to ready and starts streaming without a reload.
 */
import type * as ReactNamespace from 'react'
import { CLIENT_CSS } from './styles.ts'
import type { Translate } from './i18n.ts'
import { messageOf } from './settings-api.ts'
import { createFetchConfigApi } from './settings-api.ts'
import type { ConfigApi, PhoneConfigView } from './settings-api.ts'
import { createPanelEmptyState } from './empty-state.ts'
import { describePanelGate, loadPanelConfig } from './gate.ts'
import type { PanelGate } from './gate.ts'
import { createPhonePanelView } from './panel-view.ts'
import { createFetchProvisionApi } from './provision-api.ts'
import type { ProvisionApi } from './provision-api.ts'

export interface PanelDeps {
  React: typeof ReactNamespace
  t: Translate
  /** Injectable config API for tests/embedding. */
  api?: ConfigApi
  /** Injectable provisioning API for tests/embedding. */
  provisionApi?: ProvisionApi
}

/** Build the panel body component for the current locale. */
export function createPhonePanel(deps: PanelDeps): ReactNamespace.ComponentType {
  const { React, t } = deps
  const h = React.createElement
  const api = deps.api ?? createFetchConfigApi()
  const PhonePanelView = createPhonePanelView({ React, t, api })
  const PanelEmptyState = createPanelEmptyState({ React, t, provisionApi: deps.provisionApi ?? createFetchProvisionApi() })

  function PhonePanel(): ReactNamespace.ReactElement {
    const [config, setConfig] = React.useState<PhoneConfigView>()
    const [error, setError] = React.useState<unknown>()
    const [reloadKey, setReloadKey] = React.useState(0)
    const aliveRef = React.useRef(true)

    const load = React.useCallback(async (): Promise<PhoneConfigView | undefined> => {
      // Retry a few times: auto-open can mount this panel before the Host has
      // finished booting, and the first frame must be the consent card rather
      // than a connection error (issue #47).
      const result = await loadPanelConfig({ getConfig: () => api.getConfig() })
      if (!aliveRef.current) return result.config
      setConfig(result.config)
      setError(result.error)
      return result.config
    }, [])

    const reload = React.useCallback(async (): Promise<PhoneConfigView | undefined> => {
      try {
        const next = await api.getConfig()
        if (aliveRef.current) {
          setConfig(next)
          setError(undefined)
        }
        return next
      } catch {
        return undefined
      }
    }, [])

    React.useEffect(() => {
      aliveRef.current = true
      void load()
      return () => {
        aliveRef.current = false
      }
    }, [load, reloadKey])

    const gate: PanelGate = describePanelGate({ config, error })
    if (gate === 'ready') return h(PhonePanelView, { key: 'view' })

    return h(
      'div',
      { className: 'dshp-root' },
      h('style', { key: 'dshp-style' }, CLIENT_CSS),
      h(
        'div',
        { className: 'dshp-scroll' },
        gate === 'checking'
          ? h('div', { className: 'dshp-overlay' }, h('div', { className: 'dshp-text' }, t('panel.empty.checking')))
          : h(PanelEmptyState, {
            gate,
            config,
            api,
            reload,
            onConfig: (next: PhoneConfigView) => {
              setConfig(next)
              setError(undefined)
            },
            onRetry: () => {
              setError(undefined)
              setReloadKey((key) => key + 1)
            },
            errorMessage: error === undefined ? undefined : messageOf(error),
          }),
      ),
    )
  }

  PhonePanel.displayName = 'DshPhonePanel'
  return PhonePanel
}

/** Build the chip title component (second seat under the same tab id). */
export function createPhonePanelTitle(deps: PanelDeps): ReactNamespace.ComponentType {
  const { React, t } = deps
  function PhonePanelTitle(): ReactNamespace.ReactElement {
    return React.createElement('span', null, t('panel.title'))
  }
  PhonePanelTitle.displayName = 'DshPhonePanelTitle'
  return PhonePanelTitle
}
