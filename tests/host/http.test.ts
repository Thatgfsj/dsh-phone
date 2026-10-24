import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'

import { createApiHandler, isValidEndpointString } from '../../src/http/routes.ts'
import { RuntimeUnavailableError } from '../../src/runtime/types.ts'
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
  agentAuth: ((req: IncomingMessage) => boolean) | undefined
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
    agentAuth: undefined,
  } as unknown as Harness
  harness.handler = createApiHandler({
    service,
    getSettings: () => settings,
    getConnection: () => harness.connection,
    getConfigView: () => harness.view,
    agentAuth: async (req) => harness.agentAuth?.(req) ?? false,
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

test('POST /config：userHint 非字符串 → 400（不能被映射成 503）', async () => {
  const harness = makeHarness()
  let response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'userHint'], value: { nested: true }, revision: 5 },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')
  assert.equal(harness.settings.calls, 0)

  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'resolved'], value: 'yes', revision: 5 },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')
  assert.equal(harness.settings.calls, 0)
})

test('本地 Agent 通道 /agent/config：token 通过可写 endpoint/resolved，但禁止写 userHint（R2）', async () => {
  const harness = makeHarness()
  harness.connection = { requestRejection: () => 401 }
  harness.agentAuth = (req) =>
    (req.headers as Record<string, string>)['x-dsh-phone-token'] === 'good-token'

  // 无 token → 仍按原 requestRejection 拒绝
  let response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/agent/config',
    body: { path: ['attach', 'userHint'], value: '模拟器在 D:\\Android\\Sdk', revision: 5 },
  })
  assert.equal(response.statusCode, 401)
  assert.equal(json(response).error.code, 'E_AUTH')

  // 带正确 token 但写 userHint → 403 E_FORBIDDEN，且不落盘（SPEC §6.2 R2）
  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/agent/config',
    body: { path: ['attach', 'userHint'], value: '模拟器在 D:\\Android\\Sdk', revision: 5 },
    headers: { 'x-dsh-phone-token': 'good-token' },
  })
  assert.equal(response.statusCode, 403)
  assert.equal(json(response).error.code, 'E_FORBIDDEN')
  assert.equal(harness.settings.calls, 0)

  // verify 无 token → 仍 401；带 token → 可验证（R5）
  let verifyResponse = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/attach/verify',
    body: { endpoint: '127.0.0.1:5555' },
  })
  assert.equal(verifyResponse.statusCode, 401)
  verifyResponse = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/attach/verify',
    body: { endpoint: '127.0.0.1:5555' },
    headers: { 'x-dsh-phone-token': 'good-token' },
  })
  assert.equal(verifyResponse.statusCode, 200)
  assert.equal(json(verifyResponse).value.ok, true)

  // 带正确 token 且已 verify → 可写 endpoint（R5 + R1）
  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/agent/config',
    body: { path: ['attach', 'endpoint'], value: '127.0.0.1:5555', revision: 5 },
    headers: { 'x-dsh-phone-token': 'good-token' },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).value.attach.endpoint, '127.0.0.1:5555')
  assert.equal(harness.settings.calls, 1)

  // GET /status 也允许 Agent token（R4b 复验）
  const statusResponse = await invoke(harness, {
    method: 'GET',
    url: '/dsh-phone/api/status',
    headers: { 'x-dsh-phone-token': 'good-token' },
  })
  assert.equal(statusResponse.statusCode, 200)
  assert.equal(json(statusResponse).value.state, 'running')
})

test('浏览器 POST /config 仍允许写 userHint（设置页需要；与 Agent 通道区分）', async () => {
  const harness = makeHarness()
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'userHint'], value: 'Android Studio 装的，SDK 默认路径', revision: 5 },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).value.attach.userHint, 'Android Studio 装的，SDK 默认路径')
})

test('本地 Agent 通道：agent/config 同样受 R5 约束（未 verify 写 endpoint → 409）', async () => {
  const harness = makeHarness()
  harness.connection = { requestRejection: () => 401 }
  harness.agentAuth = () => true
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/agent/config',
    body: { path: ['attach', 'endpoint'], value: '127.0.0.1:5555', revision: 5 },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(json(response).error.code, 'E_NOT_VERIFIED')
  assert.equal(harness.settings.calls, 0)
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

test('GET /status：运行时决策树全失败 → 503 E_RUNTIME_UNAVAILABLE（issue #28）', async () => {
  const service = makeService({
    status: async () => {
      throw new RuntimeUnavailableError('attach', [
        'Linux 推荐路径：安装 Docker 并加载 binder 模块',
        '或安装 Android SDK Emulator（需 /dev/kvm）',
      ])
    },
  })
  const harness = makeHarness({ service })
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/status' })
  assert.equal(response.statusCode, 503)
  const body = json(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'E_RUNTIME_UNAVAILABLE')
  assert.equal(body.error.retryable, false)
  // message 必须保留完整安装指引，而不是被兜底成 E_DEVICE_COMMAND
  assert.match(body.error.message, /没有可用的 Android 运行时/)
  assert.match(body.error.message, /Docker/)
  assert.match(body.error.message, /Android SDK Emulator/)
  assert.equal(response.headers['cache-control'], 'no-store')

  // 同一错误不得影响 GET /config（只读配置仍可用）
  const config = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/config' })
  assert.equal(config.statusCode, 200)
  assert.equal(json(config).ok, true)
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