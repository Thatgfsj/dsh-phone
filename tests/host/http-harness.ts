import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'

import { safeGetOrigin } from '../../src/http/origin.ts'
import { createApiHandler, createReadOnlyHandler, isValidEndpointString, VERIFY_TTL_MS } from '../../src/http/routes.ts'
import type { LifecycleControllerLike, RuntimeAction, RuntimeInfo } from '../../src/phone/lifecycle-control.ts'
import type { ProvisionRequest, ProvisionStatus, ProvisionerLike } from '../../src/provisioning/types.ts'
import { RuntimeUnavailableError } from '../../src/runtime/types.ts'
import type { ConfigView, HttpRouteDeps } from '../../src/http/routes.ts'
import type { PhoneStatus } from '../../src/phone/contracts.ts'
import { makeService } from './fakes.ts'

export interface FakeResponse extends ServerResponse {
  statusCode: number
  headers: Record<string, string | number>
  body: string
}

export function makeResponse(): FakeResponse {
  const headers: Record<string, string | number> = {}
  const response = {
    statusCode: 0,
    headers,
    body: '',
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = value
      return response
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        response.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
      return response
    },
  }
  return response as unknown as FakeResponse
}

export function makeRequest(options: {
  method: string
  url: string
  body?: unknown
  auth?: number
  remoteAddress?: string
  headers?: Record<string, string>
}): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage & EventEmitter
  ;(emitter as unknown as { method: string }).method = options.method
  ;(emitter as unknown as { url: string }).url = options.url
  ;(emitter as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: options.remoteAddress ?? '127.0.0.1',
  }
  ;(emitter as unknown as { headers: Record<string, string> }).headers = options.headers ?? {}
  if (options.auth !== undefined) {
    ;(emitter as unknown as { authStatus: number }).authStatus = options.auth
  }
  const body = options.body
  setImmediate(() => {
    if (body !== undefined) {
      emitter.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    }
    emitter.emit('end')
  })
  return emitter as unknown as IncomingMessage
}

export interface Harness {
  handler: ReturnType<typeof createApiHandler>
  service: ReturnType<typeof makeService>
  settings: {
    describe(): { ns: string; revision: number; value: unknown }[]
    mutate(ns: string, ops: readonly { path: readonly string[]; value?: unknown }[], revision?: number): Promise<void>
    value: { attach: { endpoint: string; userHint: string; resolved: boolean } }
    revision: number
    calls: number
  }
  verifiedSet: Set<string>
  rechecked: number
  recheckStatus: PhoneStatus
  view: ConfigView
  connection: { requestRejection(req: IncomingMessage): number | undefined } | undefined
  agentAuth: ((req: IncomingMessage) => boolean) | undefined
  now: number
  lifecycle: LifecycleControllerLike & {
    actions: RuntimeAction[]
    nextInfo: RuntimeInfo
  }
  provisioner: ProvisionerLike & {
    requests: ProvisionRequest[]
    nextStatus: ProvisionStatus
  }
}

export function makeHarness(overrides: Partial<HttpRouteDeps> = {}): Harness {
  const service = makeService()
  const settings = {
    value: {
      attach: { endpoint: '', userHint: '', resolved: false },
      onboarding: { status: 'pending', choice: '' },
    },
    revision: 5,
    calls: 0,
    describe() {
      return [{ ns: 'dsh-phone', revision: settings.revision, value: structuredClone(settings.value) }]
    },
    async mutate(_ns: string, ops: readonly { path: readonly string[]; value?: unknown }[]) {
      settings.calls += 1
      for (const op of ops) {
        if (op.path[0] === 'attach') {
          settings.value.attach[op.path[1] as 'endpoint'] = op.value as never
        } else if (op.path[0] === 'onboarding') {
          settings.value.onboarding[op.path[1] as 'status'] = op.value as never
        }
      }
      settings.revision += 1
    },
  }
  const harness = {
    service,
    settings,
    rechecked: 0,
    recheckStatus: { state: 'running', runtime: 'attach', platform: 'linux' } as PhoneStatus,
    view: {
      enabled: true,
      runtime: 'attach',
      onboarding: { status: 'accepted', choice: '' },
      stream: { maxSize: 720, maxFps: 15, bitrate: 2000000 },
    },
    connection: { requestRejection: () => undefined },
    verifiedSet: new Set<string>(),
    agentAuth: undefined,
    now: 1_000_000,
    lifecycle: {
      actions: [],
      nextInfo: {
        state: 'stopped',
        running: false,
        owned: true,
        adopted: false,
        busy: false,
      },
      async info() {
        return harness.lifecycle.nextInfo
      },
      enqueue(action: RuntimeAction) {
        harness.lifecycle.actions.push(action)
      },
      dispose() {},
    },
    provisioner: {
      requests: [],
      nextStatus: { state: 'running', step: 'install', percent: 30, log: ['installing'], runtime: 'emulator' },
      status() {
        return harness.provisioner.nextStatus
      },
      start(request: ProvisionRequest) {
        harness.provisioner.requests.push(request)
        return harness.provisioner.nextStatus
      },
      dispose() {},
    },
  } as unknown as Harness
  harness.handler = createApiHandler({
    service,
    lifecycle: harness.lifecycle,
    provisioner: harness.provisioner,
    getSettings: () => settings,
    getConnection: () => harness.connection,
    getConfigView: () => harness.view,
    agentAuth: async (req) => harness.agentAuth?.(req) ?? false,
    now: () => harness.now,
    async recheckConnectivity() {
      harness.rechecked += 1
      return harness.recheckStatus
    },
    ...overrides,
  })
  return harness
}

export async function invoke(
  harness: Harness,
  options: {
    method: string
    url: string
    body?: unknown
    remoteAddress?: string
    headers?: Record<string, string>
  },
): Promise<FakeResponse> {
  const response = makeResponse()
  await harness.handler.handle(
    makeRequest({ ...options, auth: (harness.connection as unknown as { authStatus?: number })?.authStatus }),
    response,
  )
  return response
}

export function json(response: FakeResponse): any {
  return JSON.parse(response.body)
}

