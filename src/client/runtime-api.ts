/**
 * Browser client for the lifecycle/runtime API (host issue #83, UI part).
 *
 * Frozen contract:
 * - `GET  /dsh-phone/api/runtime` →
 *   `{state, running, owned, adopted, pid?, endpoint?, since?, busy, lastError?}`
 * - `POST /dsh-phone/api/runtime` body `{action:'start'|'stop'|'restart'}` →
 *   202 `{ok:true, action, state}`; the action runs asynchronously and the UI
 *   polls `GET /runtime` (1s while busy).
 *
 * `owned` means the plugin spawned the instance (stop may shut it down), while
 * `adopted` means the user started it (stop only disconnects). Parsing is
 * defensive so an older/malformed Host cannot break the panel.
 */
export const RUNTIME_STATES = ['stopped', 'booting', 'running', 'paused'] as const
export type RuntimeState = (typeof RUNTIME_STATES)[number]
export type RuntimeAction = 'start' | 'stop' | 'restart'

export interface RuntimeEndpoint {
  host: string
  port: number
}

export interface RuntimeView {
  state: RuntimeState
  running: boolean
  /** The plugin spawned this instance (stop may terminate it). */
  owned: boolean
  /** The user started this instance (stop only disconnects). */
  adopted: boolean
  pid?: number
  endpoint?: RuntimeEndpoint
  since?: number
  /** A start/stop/restart is currently executing on the Host. */
  busy: boolean
  lastError?: string
}

export interface RuntimeApi {
  get(): Promise<RuntimeView>
  /** Fire an action; resolves once the Host accepted it (state via polling). */
  act(action: RuntimeAction): Promise<void>
}

/** Error carrying the protocol code/status (404 means the Host lacks #83). */
export class RuntimeApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'RuntimeApiError'
    this.code = code
    this.status = status
  }
}

function isState(value: unknown): value is RuntimeState {
  return typeof value === 'string' && (RUNTIME_STATES as readonly string[]).includes(value)
}

function isEndpoint(value: unknown): value is RuntimeEndpoint {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.host === 'string' && typeof record.port === 'number'
}

/** Normalize one `GET /runtime` value into a safe view. */
export function parseRuntimeView(value: unknown): RuntimeView {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const state = isState(record.state) ? record.state : 'stopped'
  return {
    state,
    running: typeof record.running === 'boolean' ? record.running : state === 'running',
    owned: record.owned === true,
    adopted: record.adopted === true,
    pid: typeof record.pid === 'number' ? record.pid : undefined,
    endpoint: isEndpoint(record.endpoint) ? { host: record.endpoint.host, port: record.endpoint.port } : undefined,
    since: typeof record.since === 'number' ? record.since : undefined,
    busy: record.busy === true,
    lastError: typeof record.lastError === 'string' && record.lastError !== '' ? record.lastError : undefined,
  }
}

/** True when the Host does not implement the lifecycle API (older build). */
export function isRuntimeUnsupported(error: unknown): boolean {
  if (!(error instanceof RuntimeApiError)) return false
  return error.status === 404 || error.code === 'E_NOT_FOUND' || error.code === 'E_NO_WEB'
}

/** Who owns the instance: plugin-spawned, user-started, or unknown. */
export type Ownership = 'owned' | 'adopted' | 'unknown'

export function describeOwnership(view: Pick<RuntimeView, 'owned' | 'adopted'> | undefined): Ownership {
  if (view?.owned === true) return 'owned'
  if (view?.adopted === true) return 'adopted'
  return 'unknown'
}

/** Label key for the destructive "stop" button (close vs disconnect). */
export function stopActionKey(view: Pick<RuntimeView, 'owned' | 'adopted'> | undefined): string {
  return describeOwnership(view) === 'owned' ? 'runtime.action.stopOwned' : 'runtime.action.disconnect'
}

/** Confirmation copy key for the destructive stop. */
export function stopConfirmKey(view: Pick<RuntimeView, 'owned' | 'adopted'> | undefined): string {
  return describeOwnership(view) === 'owned' ? 'runtime.confirm.stopOwned' : 'runtime.confirm.disconnect'
}

/** Human label key for an action's busy phase. */
export function actionProgressKey(action: RuntimeAction): string {
  switch (action) {
    case 'start':
      return 'runtime.busy.start'
    case 'stop':
      return 'runtime.busy.stop'
    case 'restart':
      return 'runtime.busy.restart'
  }
}

/** True when the action makes sense for the current state (and nothing is busy). */
export function isActionAvailable(view: RuntimeView | undefined, action: RuntimeAction): boolean {
  if (view === undefined || view.busy) return false
  switch (action) {
    case 'start':
      return view.state === 'stopped'
    case 'stop':
      return view.state !== 'stopped'
    case 'restart':
      return view.state !== 'stopped'
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
  throw new RuntimeApiError(code, message, response.status)
}

/** Browser `fetch` implementation of the lifecycle contract. */
export function createFetchRuntimeApi(base = '/dsh-phone/api'): RuntimeApi {
  return {
    get: async () => parseRuntimeView(await requestJson(base + '/runtime')),
    act: async (action) => {
      await requestJson(base + '/runtime', { method: 'POST', body: JSON.stringify({ action }) })
    },
  }
}
