import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'

import { createApiHandler, isValidEndpointString } from '../../src/http/routes.ts'
import type { ConfigView, HttpRouteDeps } from '../../src/http/routes.ts'
import type { PhoneStatus } from '../../src/phone/contracts.ts'
import { makeService } from './fakes.ts'

interface FakeResponse extends ServerResponse {
  statusCode: number
  headers: Record<string, string | number>
  body: string
}

function makeResponse(): FakeResponse {
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

function makeRequest(options: {
  method: string
  url: string
  body?: unknown
  auth?: number
}): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage & EventEmitter
  ;(emitter as unknown as { method: string }).method = options.method
  ;(emitter as unknown as { url: string }).url = options.url
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

interface Harness {
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
}

function makeHarness(overrides: Partial<HttpRouteDeps> = {}): Harness {
  const service = makeService()
  const settings = {
    value: { attach: { endpoint: '', userHint: '', resolved: false } },
    revision: 5,
    calls: 0,
    describe() {
      return [{ ns: 'dsh-phone', revision: settings.revision, value: structuredClone(settings.value) }]
    },
    async mutate(_ns: string, ops: readonly { path: readonly string[]; value?: unknown }[]) {
      settings.calls += 1
      for (const op of ops) {
        settings.value.attach[op.path[1] as 'endpoint'] = op.value as never
      }
      settings.revision += 1
    },
  }
  const harness = {
    service,
    settings,
    rechecked: 0,
    recheckStatus: { state: 'running', runtime: 'attach', platform: 'linux' } as PhoneStatus,
    view: { runtime: 'attach', stream: { maxSize: 720, maxFps: 15, bitrate: 2000000 } },
    connection: { requestRejection: () => undefined },
    verifiedSet: new Set<string>(),
  } as unknown as Harness
  harness.handler = createApiHandler({
    service,
    getSettings: () => settings,
    getConnection: () => harness.connection,
    getConfigView: () => harness.view,
    async recheckConnectivity() {
      harness.rechecked += 1
      return harness.recheckStatus
    },
    ...overrides,
  })
  return harness
}

async function invoke(
  harness: Harness,
  options: { method: string; url: string; body?: unknown },
): Promise<FakeResponse> {
  const response = makeResponse()
  await harness.handler.handle(
    makeRequest({ ...options, auth: (harness.connection as unknown as { authStatus?: number })?.authStatus }),
    response,
  )
  return response
}

function json(response: FakeResponse): any {
  return JSON.parse(response.body)
}

test('鉴权：connection 缺失 → 503 E_NO_WEB', async () => {
  const harness = makeHarness({ getConnection: () => undefined })
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/status' })
  assert.equal(response.statusCode, 503)
  assert.equal(json(response).error.code, 'E_NO_WEB')
})

test('鉴权：requestRejection 401/403 → E_AUTH / E_ORIGIN', async () => {
  const harness = makeHarness()
  harness.connection = { requestRejection: () => 401 }
  let response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/status' })
  assert.equal(response.statusCode, 401)
  assert.equal(json(response).error.code, 'E_AUTH')

  harness.connection = { requestRejection: () => 403 }
  response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/status' })
  assert.equal(response.statusCode, 403)
  assert.equal(json(response).error.code, 'E_ORIGIN')
})

test('GET /status 与 GET /config：成功体 + no-store', async () => {
  const harness = makeHarness()
  const status = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/status' })
  assert.equal(status.statusCode, 200)
  assert.equal(json(status).ok, true)
  assert.equal(json(status).value.state, 'running')
  assert.equal(status.headers['cache-control'], 'no-store')

  const config = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/config' })
  assert.equal(config.statusCode, 200)
  assert.deepEqual(json(config).value, {
    runtime: 'attach',
    attach: { endpoint: '', userHint: '', resolved: false },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2000000 },
    revision: 5,
  })
  assert.equal(config.headers['cache-control'], 'no-store')
})

test('POST /config：非法路径 400 E_BAD_PATH；非白名单字段 400', async () => {
  const harness = makeHarness()
  let response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['runtime'], value: 'attach', revision: 5 },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_PATH')

  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: 'attach.userHint', value: 'x', revision: 5 },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')
})

test('POST /config：userHint 直接写入（无需 verify），返回新 revision', async () => {
  const harness = makeHarness()
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'userHint'], value: '模拟器在 D:\\Android\\Sdk', revision: 5 },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).ok, true)
  assert.equal(json(response).value.attach.userHint, '模拟器在 D:\\Android\\Sdk')
  assert.equal(json(response).value.revision, 6)
  assert.equal(harness.settings.calls, 1)
  assert.equal(harness.rechecked, 0)
})

test('R5：未 verify 写 endpoint → 409 E_NOT_VERIFIED；verify 后可写并复验 running', async () => {
  const harness = makeHarness()
  let response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'endpoint'], value: '127.0.0.1:5555', revision: 5 },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(json(response).error.code, 'E_NOT_VERIFIED')

  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/attach/verify',
    body: { endpoint: '127.0.0.1:5555' },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).value.ok, true)

  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'endpoint'], value: '127.0.0.1:5555', revision: 5 },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).value.attach.endpoint, '127.0.0.1:5555')
  assert.equal(harness.rechecked, 1)
})

test('R5/R4：verify 后 resolved=true 可写；复验非 running → 502 E_DEVICE_DISCONNECTED', async () => {
  const harness = makeHarness()
  await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/attach/verify',
    body: { endpoint: '127.0.0.1:5555' },
  })
  harness.settings.value.attach.endpoint = '127.0.0.1:5555'
  harness.recheckStatus = { state: 'stopped', runtime: 'attach', platform: 'linux', lastError: 'refused' }

  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'resolved'], value: true, revision: 5 },
  })
  assert.equal(response.statusCode, 502)
  assert.equal(json(response).error.code, 'E_DEVICE_DISCONNECTED')
  assert.equal(json(response).error.retryable, true)
  assert.equal(harness.settings.value.attach.resolved, true)
})

test('verify 失败：200 + ok:false（便于列候选），不写配置', async () => {
  const service = makeService()
  service.verifyEndpoint = async () => ({ ok: false, latencyMs: 1200, error: 'ECONNREFUSED' })
  const harness = makeHarness({ service })
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/attach/verify',
    body: { endpoint: '127.0.0.1:5555' },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).value.ok, false)
  assert.equal(harness.settings.calls, 0)
})

test('GET /screenshot：image/png；booting → 200 JSON E_BOOTING', async () => {
  const harness = makeHarness()
  let response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/screenshot' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/png')
  assert.equal(response.headers['cache-control'], 'no-store')

  const service = makeService()
  service.setReadiness({ state: 'booting', bootMs: 2000 })
  const booting = makeHarness({ service })
  response = await invoke(booting, { method: 'GET', url: '/dsh-phone/api/screenshot' })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).error.code, 'E_BOOTING')
  assert.equal(json(response).error.bootMs, 2000)
})

test('未知路由 → 404 E_BAD_REQUEST', async () => {
  const harness = makeHarness()
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/nope' })
  assert.equal(response.statusCode, 404)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')
})

test('isValidEndpointString：host:port 严格校验', () => {
  assert.ok(isValidEndpointString('127.0.0.1:5555'))
  assert.ok(isValidEndpointString('localhost:16384'))
  assert.equal(isValidEndpointString('127.0.0.1'), false)
  assert.equal(isValidEndpointString('127.0.0.1:0'), false)
  assert.equal(isValidEndpointString('127.0.0.1:70000'), false)
  assert.equal(isValidEndpointString(''), false)
  assert.equal(isValidEndpointString(42), false)
})
