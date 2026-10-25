/**
 * Browser client for the one-click provisioning API (host issue #65, UI #66).
 *
 * Frozen contract:
 * - `GET  /dsh-phone/api/provision` → `{state, step, percent, log[], error?, runtime?}`
 *   with state ∈ idle|running|done|failed and log = the last ~50 lines;
 * - `POST /dsh-phone/api/provision` body `{runtime, image?}` starts (or returns
 *   the current) job — only a user click should call it.
 *
 * Responses use the same `{ok:true,value}` / `{ok:false,error}` envelope as the
 * rest of `/dsh-phone/api`. Parsing is defensive: a malformed row must not crash
 * the settings/panel UI.
 */
export const PROVISION_STATES = ['idle', 'running', 'done', 'failed'] as const
export type ProvisionState = (typeof PROVISION_STATES)[number]
export type ProvisionRuntime = 'emulator' | 'redroid' | 'attach'
export type ProvisionImage = 'google_apis' | 'aosp_atd'

export interface ProvisionStatus {
  state: ProvisionState
  /** Current phase: idle|precheck|install|licenses|avd|verify|done|failed. */
  step: string
  /** 0-100 phase progress. */
  percent: number
  /** Recent log lines (host keeps the last ~50). */
  log: string[]
  error?: string
  runtime?: ProvisionRuntime
}

export interface ProvisionApi {
  get(): Promise<ProvisionStatus>
  start(runtime: ProvisionRuntime, image?: ProvisionImage): Promise<ProvisionStatus>
}

/** Error carrying the protocol code/status (404 means the Host lacks #65). */
export class ProvisionApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'ProvisionApiError'
    this.code = code
    this.status = status
  }
}

function isState(value: unknown): value is ProvisionState {
  return typeof value === 'string' && (PROVISION_STATES as readonly string[]).includes(value)
}

function isRuntime(value: unknown): value is ProvisionRuntime {
  return value === 'emulator' || value === 'redroid' || value === 'attach'
}

/** Normalize one `GET/POST /provision` value into a safe status object. */
export function parseProvisionStatus(value: unknown): ProvisionStatus {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const rawPercent = typeof record.percent === 'number' && Number.isFinite(record.percent) ? record.percent : 0
  const log = Array.isArray(record.log)
    ? record.log.filter((line): line is string => typeof line === 'string').slice(-50)
    : []
  return {
    state: isState(record.state) ? record.state : 'idle',
    step: typeof record.step === 'string' && record.step !== '' ? record.step : 'idle',
    percent: Math.min(100, Math.max(0, Math.round(rawPercent))),
    log,
    error: typeof record.error === 'string' && record.error !== '' ? record.error : undefined,
    runtime: isRuntime(record.runtime) ? record.runtime : undefined,
  }
}

/** Last N log lines, oldest first (the card shows 3-5). */
export function recentLog(log: readonly string[], count = 5): string[] {
  return log.slice(Math.max(0, log.length - Math.max(1, count)))
}

/** i18n key for a provisioning phase; unknown phases degrade to "working". */
export function provisionStepKey(step: string): string {
  switch (step) {
    case 'precheck':
      return 'provision.step.precheck'
    case 'install':
      return 'provision.step.install'
    case 'licenses':
      return 'provision.step.licenses'
    case 'avd':
      return 'provision.step.avd'
    case 'verify':
      return 'provision.step.verify'
    case 'done':
      return 'provision.step.done'
    case 'failed':
      return 'provision.step.failed'
    case 'idle':
      return 'provision.step.idle'
    default:
      return 'provision.step.working'
  }
}

/** True when the Host does not implement provisioning (old build / disabled). */
export function isProvisionUnsupported(error: unknown): boolean {
  if (!(error instanceof ProvisionApiError)) return false
  return error.status === 404 || error.code === 'E_BAD_REQUEST' || error.code === 'E_NO_WEB'
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
  throw new ProvisionApiError(code, message, response.status)
}

/** Browser `fetch` implementation of the provisioning contract. */
export function createFetchProvisionApi(base = '/dsh-phone/api'): ProvisionApi {
  return {
    get: async () => parseProvisionStatus(await requestJson(base + '/provision')),
    start: async (runtime, image) =>
      parseProvisionStatus(
        await requestJson(base + '/provision', {
          method: 'POST',
          body: JSON.stringify(image === undefined ? { runtime } : { runtime, image }),
        }),
      ),
  }
}
