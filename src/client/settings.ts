/**
 * Settings section for dsh-phone.
 *
 * Reads/writes only the frozen HTTP API (docs/protocol.md §1): GET/POST
 * `/dsh-phone/api/config` and GET `/dsh-phone/api/status`. The one-liner goes
 * to `attach.userHint`; "reset resolution" writes `attach.resolved:false` and
 * is deliberately a user click (SPEC §6.2: the Agent never resets it).
 *
 * Conflicts (409 `E_CONFIG_CONFLICT`) refresh the revision and retry once; a
 * second failure is shown to the user instead of looping.
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './panel.ts'
import { CLIENT_CSS } from './styles.ts'

export interface PhoneConfigView {
  runtime: string
  attach: { endpoint: string; userHint: string; resolved: boolean }
  stream: { maxSize: number; maxFps: number; bitrate: number }
  revision: number
}

export interface PhoneStatusView {
  state: string
  runtime: string
  lastError?: string
  endpoint?: { host: string; port: number }
}

export interface ConfigApi {
  getConfig(): Promise<PhoneConfigView>
  writeConfig(path: string[], value: unknown, revision: number): Promise<PhoneConfigView>
  getStatus(): Promise<PhoneStatusView>
}

interface ApiErrorBody {
  code?: string
  message?: string
}

/** Error carrying the protocol error code (e.g. `E_CONFIG_CONFLICT`). */
export class ConfigApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConfigApiError'
    this.code = code
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  const record = (payload ?? {}) as { ok?: boolean; value?: T; error?: ApiErrorBody }
  if (response.ok && record.ok === true) return record.value as T
  const code = record.error?.code ?? (response.status === 503 ? 'E_NO_WEB' : 'E_HTTP')
  const message = record.error?.message ?? `HTTP ${response.status}`
  throw new ConfigApiError(code, message)
}

/** Browser `fetch` implementation of the frozen HTTP contract. */
export function createFetchConfigApi(base = '/dsh-phone/api'): ConfigApi {
  return {
    getConfig: () => requestJson<PhoneConfigView>(`${base}/config`),
    getStatus: () => requestJson<PhoneStatusView>(`${base}/status`),
    writeConfig: (path, value, revision) =>
      requestJson<PhoneConfigView>(`${base}/config`, {
        method: 'POST',
        body: JSON.stringify({ path, value, revision }),
      }),
  }
}

export interface SettingsDeps {
  React: typeof ReactNamespace
  t: Translate
  api?: ConfigApi
  /** Opens the right-Sidebar phone tab (the Host decides the tab kind). */
  openPanel: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isConflict(error: unknown): boolean {
  return error instanceof ConfigApiError && error.code === 'E_CONFIG_CONFLICT'
}

/** Build the settings section component for the current locale. */
export function createPhoneSettings(deps: SettingsDeps): ReactNamespace.ComponentType {
  const { React, t } = deps
  const h = React.createElement
  const api = deps.api ?? createFetchConfigApi()

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
          api.getStatus().catch(() => undefined),
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
      try {
        return await api.writeConfig(path, value, current.revision)
      } catch (failure) {
        if (!isConflict(failure)) throw failure
        const fresh = await load()
        if (fresh === undefined) throw failure
        const next = await api.writeConfig(path, value, fresh.revision)
        setMessage(t('settings.hint.conflict'))
        return next
      }
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
      h(
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
      ),
      rows.length === 0
        ? null
        : h(
            'dl',
            { className: 'dshp-kv' },
            ...rows.flatMap((row) => [
              h('dt', { key: `${row.label}-dt` }, row.label),
              h('dd', { key: `${row.label}-dd` }, row.value),
            ]),
          ),
      h(
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
      ),
    )
  }

  PhoneSettings.displayName = 'DshPhoneSettings'
  return PhoneSettings
}
