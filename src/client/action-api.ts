/**
 * Browser client for one-shot phone UI actions (issue #101).
 *
 * Contract: `POST /dsh-phone/api/action` with `{action:'app-drawer'}` opens the
 * launcher's app drawer on the device. `409 E_APP_DRAWER_UNAVAILABLE` means the
 * instance lacks the Feiyu launcher customization; every other failure is shown
 * with its Host message. The action is idempotent enough for a button (busy
 * disables repeats on the client).
 */
export type PhoneAction = 'app-drawer'

export interface ActionApi {
  /** Fire one UI action; resolves when the Host accepted and delivered it. */
  run(action: PhoneAction): Promise<void>
}

/** Error carrying the protocol code/status (e.g. 409 E_APP_DRAWER_UNAVAILABLE). */
export class ActionApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'ActionApiError'
    this.code = code
    this.status = status
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
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
  const record = (payload ?? {}) as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
  if (response.ok && record.ok === true) return record.value
  const code = record.error?.code ?? (response.status === 404 ? 'E_NOT_FOUND' : 'E_HTTP')
  const message = record.error?.message ?? 'HTTP ' + response.status
  throw new ActionApiError(code, message, response.status)
}

/** Browser `fetch` implementation of the action contract. */
export function createFetchActionApi(base = '/dsh-phone/api'): ActionApi {
  return {
    run: async (action) => {
      await requestJson(base + '/action', { method: 'POST', body: JSON.stringify({ action }) })
    },
  }
}

/** True when the Host says this instance has no launcher app drawer. */
export function isAppDrawerUnavailable(error: unknown): boolean {
  return error instanceof ActionApiError && error.code === 'E_APP_DRAWER_UNAVAILABLE'
}

/** 'unavailable' gets the actionable launcher hint; everything else is generic. */
export type ActionErrorKind = 'unavailable' | 'error'

export function actionErrorKind(error: unknown): ActionErrorKind {
  return isAppDrawerUnavailable(error) ? 'unavailable' : 'error'
}

/** i18n key for a failed action (the component formats the message placeholder). */
export function actionErrorKey(error: unknown): string {
  return actionErrorKind(error) === 'unavailable' ? 'panel.app.unavailable' : 'panel.app.failed'
}
