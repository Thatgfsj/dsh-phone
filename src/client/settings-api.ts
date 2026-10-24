/**
 * Settings HTTP client for dsh-phone (docs/protocol.md §1).
 *
 * Kept apart from the React component so the conflict-retry policy is
 * unit-testable without rendering: write one key with the last known
 * revision, refresh and retry exactly once on 409 `E_CONFIG_CONFLICT`.
 */
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

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isConflict(error: unknown): boolean {
  return error instanceof ConfigApiError && error.code === 'E_CONFIG_CONFLICT'
}

export interface WriteOutcome {
  value: PhoneConfigView
  /** True when a 409 was observed and the write succeeded on the refreshed revision. */
  retried: boolean
}

/**
 * Write one config key, refreshing the revision and retrying once on a 409
 * (docs/protocol.md §1: `E_CONFIG_CONFLICT` is retryable exactly once).
 * @returns the fresh config plus whether the retry path ran.
 */
export async function writeWithConflictRetry(
  api: Pick<ConfigApi, 'writeConfig'>,
  path: string[],
  value: unknown,
  revision: number,
  reload: () => Promise<PhoneConfigView | undefined>,
): Promise<WriteOutcome> {
  try {
    return { value: await api.writeConfig(path, value, revision), retried: false }
  } catch (failure) {
    if (!isConflict(failure)) throw failure
    const fresh = await reload()
    if (fresh === undefined) throw failure
    return { value: await api.writeConfig(path, value, fresh.revision), retried: true }
  }
}


