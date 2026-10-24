/**
 * Settings section for dsh-phone.
 *
 * Shows the resolved/endpoint/run state, edits the one-liner (`attach.userHint`)
 * and lets the user reset resolution (`attach.resolved:false`). The HTTP client
 * and its 409 retry policy live in settings-api.ts.
 *
 * SPEC §6.2: resetting is a user action only; the Agent never calls it.
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './panel.ts'
import { CLIENT_CSS } from './styles.ts'
import { ConfigApiError, createFetchConfigApi, messageOf, readRunStatus, writeWithConflictRetry } from './settings-api.ts'
import type { ConfigApi, PhoneConfigView, PhoneStatusView } from './settings-api.ts'
import { choiceLabelKey, createOnboardingCard, describeOnboarding } from './onboarding.ts'

export interface SettingsDeps {
  React: typeof ReactNamespace
  t: Translate
  api?: ConfigApi
  /** Opens the right-Sidebar phone tab (the Host decides the tab kind). */
  openPanel: () => void
}

/** Build the settings section component for the current locale. */
export function createPhoneSettings(deps: SettingsDeps): ReactNamespace.ComponentType {
  const { React, t } = deps
  const h = React.createElement
  const api = deps.api ?? createFetchConfigApi()
  const OnboardingCard = createOnboardingCard({ React, t })

  function PhoneSettings(): ReactNamespace.ReactElement {
    const [config, setConfig] = React.useState<PhoneConfigView>()
    const [status, setStatus] = React.useState<PhoneStatusView>()
    const [draft, setDraft] = React.useState('')
    const [loading, setLoading] = React.useState(true)
    const [busy, setBusy] = React.useState<'save' | 'reset' | undefined>(undefined)
    const [message, setMessage] = React.useState<string>()
    const [error, setError] = React.useState<string>()
    const aliveRef = React.useRef(true)

    const load = React.useCallback(async (): Promise<PhoneConfigView | undefined> => {
      try {
        const [next, state] = await Promise.all([
          api.getConfig(),
          readRunStatus(api).catch(() => undefined),
        ])
        if (!aliveRef.current) return next
        setConfig(next)
        setDraft(next.attach.userHint)
        if (state !== undefined) setStatus(state)
        setError(undefined)
        return next
      } catch (failure) {
        if (aliveRef.current) setError(t('settings.loadFailed', { message: messageOf(failure) }))
        return undefined
      }
    }, [])

    React.useEffect(() => {
      aliveRef.current = true
      void load().finally(() => {
        if (aliveRef.current) setLoading(false)
      })
      return () => {
        aliveRef.current = false
      }
    }, [load])

    const write = async (path: string[], value: unknown): Promise<PhoneConfigView> => {
      const current = config
      if (current === undefined) throw new ConfigApiError('E_NO_CONFIG', t('settings.unavailable'))
      const outcome = await writeWithConflictRetry(api, path, value, current.revision, load)
      if (outcome.retried) setMessage(t('settings.hint.conflict'))
      return outcome.value
    }

    const onSave = async (): Promise<void> => {
      setBusy('save')
      setError(undefined)
      try {
        const next = await write(['attach', 'userHint'], draft)
        setConfig(next)
        setDraft(next.attach.userHint)
        setMessage(t('settings.hint.saved'))
      } catch (failure) {
        setError(t('settings.hint.failed', { message: messageOf(failure) }))
      } finally {
        setBusy(undefined)
      }
    }

    const onReset = async (): Promise<void> => {
      if (typeof window !== 'undefined' && !window.confirm(t('settings.reset.confirm'))) return
      setBusy('reset')
      setError(undefined)
      try {
        const next = await write(['attach', 'resolved'], false)
        setConfig(next)
        setMessage(t('settings.reset.done'))
      } catch (failure) {
        setError(t('settings.reset.failed', { message: messageOf(failure) }))
      } finally {
        setBusy(undefined)
      }
    }

    const mode = describeOnboarding(config)
    const rows: { label: string; value: string }[] = []
    if (config !== undefined) {
      rows.push({
        label: t('settings.state.resolved'),
        value: config.attach.resolved ? t('settings.state.resolved') : t('settings.state.unresolved'),
      })
      rows.push({
        label: t('settings.state.endpoint'),
        value: config.attach.endpoint === '' ? t('settings.state.endpointNone') : config.attach.endpoint,
      })
      rows.push({ label: t('settings.state.runtime'), value: config.runtime })
      rows.push({ label: t('settings.state.onboarding'), value: t(choiceLabelKey(mode.choice)) })
    }
    if (status !== undefined) {
      rows.push({ label: t('settings.state.runState'), value: status.state })
      if (status.endpoint !== undefined) {
        rows.push({
          label: t('settings.state.endpoint'),
          value: `${status.endpoint.host}:${status.endpoint.port}`,
        })
      }
      if (status.lastError !== undefined && status.lastError !== '') {
        rows.push({ label: t('settings.state.lastError'), value: status.lastError })
      }
    }

    return h(
      'div',
      { className: 'dshp-root' },
      h('style', { key: 'dshp-style' }, CLIENT_CSS),
      h('h3', { style: { margin: 0 } }, t('settings.title')),
      h('p', { className: 'dshp-hint', style: { margin: 0 } }, t('settings.description')),
      loading ? h('p', { className: 'dshp-hint' }, t('settings.loading')) : null,
      error === undefined ? null : h('p', { className: 'dshp-error' }, error),
      config === undefined
        ? null
        : h(OnboardingCard, {
            key: 'onboarding',
            api,
            config,
            reload: load,
            onConfig: (next: PhoneConfigView) => {
              setConfig(next)
              setDraft(next.attach.userHint)
            },
            onMessage: (text: string) => setMessage(text),
            onError: (text: string | undefined) => setError(text),
          }),
      mode.showSetup
        ? h(
            'div',
            { className: 'dshp-field' },
        h('label', { htmlFor: 'dshp-user-hint' }, t('settings.hint.label')),
        h('textarea', {
          id: 'dshp-user-hint',
          className: 'dshp-input',
          value: draft,
          placeholder: t('settings.hint.placeholder'),
          onChange: (event: ReactNamespace.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value),
          disabled: loading || busy !== undefined,
        }),
        h(
          'div',
          { className: 'dshp-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshp-button',
              'data-variant': 'primary',
              onClick: () => void onSave(),
              disabled: loading || busy !== undefined || draft === config?.attach.userHint,
            },
            busy === 'save' ? t('settings.hint.saving') : t('settings.hint.save'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshp-button',
              onClick: () => void load(),
              disabled: loading || busy !== undefined,
            },
            t('settings.refresh'),
          ),
          message === undefined ? null : h('span', { className: 'dshp-hint' }, message),
        ),
      )
        : null,
      !mode.showSetup || rows.length === 0
        ? null
        : h(
            'dl',
            { className: 'dshp-kv' },
            ...rows.flatMap((row) => [
              h('dt', { key: `${row.label}-dt` }, row.label),
              h('dd', { key: `${row.label}-dd` }, row.value),
            ]),
          ),
      mode.showSetup
        ? h(
            'div',
            { className: 'dshp-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshp-button',
                onClick: () => void onReset(),
            disabled: loading || busy !== undefined,
          },
          busy === 'reset' ? t('settings.hint.saving') : t('settings.reset'),
        ),
        h(
          'button',
          { type: 'button', className: 'dshp-button', onClick: deps.openPanel },
          t('settings.openPanel'),
        ),
      )
        : null,
    )
  }

  PhoneSettings.displayName = 'DshPhoneSettings'
  return PhoneSettings
}
