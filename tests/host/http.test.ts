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

function makeHarness(overrides: Partial<HttpRouteDeps> = {}): Harness {
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
    enabled: true,
    runtime: 'attach',
    onboarding: { status: 'pending', choice: '' },
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

test('GET /status：onboarding pending → 200 + E_ONBOARDING_REQUIRED（不触碰设备）', async () => {
  const harness = makeHarness()
  harness.view.onboarding = { status: 'pending', choice: '' }
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/status' })
  assert.equal(response.statusCode, 200)
  const body = json(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'E_ONBOARDING_REQUIRED')
  assert.equal(body.error.retryable, false)
  assert.equal(body.error.onboarding.step, 'consent')
  assert.deepEqual(
    body.error.onboarding.options.map((option: { id: string }) => option.id),
    ['emulator', 'redroid', 'attach', 'decline'],
  )
  assert.equal(body.error.onboarding.install.emulator.size, '~1.7GB')
  assert.equal(body.error.onboarding.docs, 'docs/usage.md#首次使用')
  // 未调用 service.status（不碰 runtime）
  assert.equal(harness.service.calls.includes('status'), false)
})

test('GET /status：onboarding declined → 200 + E_ONBOARDING_DECLINED（不触碰设备）', async () => {
  const harness = makeHarness()
  harness.view.onboarding = { status: 'declined', choice: 'attach' }
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/status' })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).error.code, 'E_ONBOARDING_DECLINED')
  assert.equal(harness.service.calls.includes('status'), false)
})

test('GET /screenshot：onboarding pending → 200 JSON 错误，不触发 ensureInteractive', async () => {
  const harness = makeHarness()
  harness.view.onboarding = { status: 'pending', choice: '' }
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/screenshot' })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).error.code, 'E_ONBOARDING_REQUIRED')
  assert.equal(harness.service.calls.includes('ensureInteractive'), false)
})

test('POST /config：写 onboarding.status/choice 生效并回读（R4）', async () => {
  const harness = makeHarness()
  let response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['onboarding', 'status'], value: 'accepted', revision: 5 },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).value.onboarding.status, 'accepted')
  assert.equal(json(response).value.revision, 6)

  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['onboarding', 'choice'], value: 'emulator', revision: 6 },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(json(response).value.onboarding, { status: 'accepted', choice: 'emulator' })
})

test('POST /config：onboarding 非法值 → 400 E_BAD_REQUEST', async () => {
  const harness = makeHarness()
  for (const [path, value] of [
    [['onboarding', 'status'], 'yes'],
    [['onboarding', 'choice'], 'waydroid'],
  ] as const) {
    const response = await invoke(harness, {
      method: 'POST',
      url: '/dsh-phone/api/config',
      body: { path, value, revision: 5 },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(json(response).error.code, 'E_BAD_REQUEST')
  }
  assert.equal(harness.settings.calls, 0)
})

test('本地 Agent 通道不得自授权：onboarding.* 与 userHint 均 403（issue #71）', async () => {
  const harness = makeHarness()
  harness.connection = { requestRejection: () => 401 }
  harness.agentAuth = (req) =>
    (req.headers as Record<string, string>)['x-dsh-phone-token'] === 'good-token'

  for (const [path, value] of [
    [['onboarding', 'status'], 'accepted'],
    [['onboarding', 'choice'], 'emulator'],
    [['attach', 'userHint'], '不该被 Agent 写'],
  ] as const) {
    const response = await invoke(harness, {
      method: 'POST',
      url: '/dsh-phone/api/agent/config',
      body: { path, value, revision: 5 },
      headers: { 'x-dsh-phone-token': 'good-token' },
    })
    assert.equal(response.statusCode, 403, path.join('.'))
    assert.equal(json(response).error.code, 'E_FORBIDDEN', path.join('.'))
  }
  assert.equal(harness.settings.calls, 0)
  // 浏览器同源通道仍可写 onboarding（设置页/引导卡片）
  harness.connection = { requestRejection: () => undefined }
  const browser = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['onboarding', 'status'], value: 'accepted', revision: 5 },
  })
  assert.equal(browser.statusCode, 200)
  assert.equal(json(browser).value.onboarding.status, 'accepted')
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
/* ---------------------- issue #52：GET /config 暴露 enabled ---------------------- */

function readOnlySnapshot(harness: Harness, enabled: boolean): Promise<FakeResponse> {
  const handler = createReadOnlyHandler({
    getSettings: () => harness.settings as never,
    getConnection: () => harness.connection,
    getConfigView: () => ({ ...harness.view, enabled }),
  })
  const response = makeResponse()
  return handler
    .handle(
      makeRequest({ method: 'GET', url: '/dsh-phone/api/config' }),
      response,
    )
    .then(() => response)
}

test('GET /config：enabled=true/false 两个 handler 都返回 enabled 且形状一致', async () => {
  const harness = makeHarness()

  // 主 handler（enabled=true）
  harness.view.enabled = true
  const main = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/config' })
  assert.equal(main.statusCode, 200)
  const mainValue = json(main).value
  assert.equal(mainValue.enabled, true)

  // 只读 handler（enabled=false）：形状与主 handler 完全一致
  harness.view.enabled = false
  const readOnly = await readOnlySnapshot(harness, false)
  assert.equal(readOnly.statusCode, 200)
  const readOnlyValue = json(readOnly).value
  assert.equal(readOnlyValue.enabled, false)
  assert.deepEqual(Object.keys(readOnlyValue).sort(), Object.keys(mainValue).sort())
  assert.equal(readOnlyValue.runtime, mainValue.runtime)
  assert.deepEqual(readOnlyValue.attach, mainValue.attach)
  assert.deepEqual(readOnlyValue.onboarding, mainValue.onboarding)
  assert.deepEqual(readOnlyValue.stream, mainValue.stream)

  // 只读 handler 在 enabled=true 时也保留 enabled（形状统一）
  const readOnlyTrue = await readOnlySnapshot(harness, true)
  assert.equal(json(readOnlyTrue).value.enabled, true)
  assert.deepEqual(
    Object.keys(json(readOnlyTrue).value).sort(),
    Object.keys(mainValue).sort(),
  )
})

test('GET /config（只读 handler）：enabled=false 时仍可读，且不改写/不要求写权限', async () => {
  const harness = makeHarness()
  const response = await readOnlySnapshot(harness, false)
  assert.equal(response.statusCode, 200)
  assert.equal(json(response).ok, true)
  assert.equal(json(response).value.enabled, false)
  assert.equal(response.headers['cache-control'], 'no-store')
})
/* ------------------------- issue #65：Provisioning API ------------------------- */

test('GET /provision：返回当前状态（200 + 稳定字段）', async () => {
  const harness = makeHarness()
  harness.provisioner.nextStatus = {
    state: 'done',
    step: 'done',
    percent: 100,
    log: ['准备完成'],
    runtime: 'emulator',
  }
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/provision' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(json(response).value, {
    state: 'done',
    step: 'done',
    percent: 100,
    log: ['准备完成'],
    runtime: 'emulator',
  })
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('POST /provision：浏览器同源请求触发 provisioner.start（runtime+image 透传）', async () => {
  const harness = makeHarness()
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/provision',
    body: { runtime: 'emulator', image: 'aosp_atd' },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(harness.provisioner.requests, [{ runtime: 'emulator', image: 'aosp_atd' }])
  assert.equal(json(response).value.state, 'running')
})

test('POST /provision：非法 runtime/image → 400 E_BAD_REQUEST（不触发 provisioner）', async () => {
  const harness = makeHarness()
  let response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/provision',
    body: { runtime: 'waydroid' },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')

  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/provision',
    body: { runtime: 'emulator', image: 'pixel' },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')
  assert.equal(harness.provisioner.requests.length, 0)
})

test('POST /provision：agent token 不被允许（仅浏览器同源；防止 Agent 自动装软件）', async () => {
  const harness = makeHarness()
  harness.connection = { requestRejection: () => 401 }
  harness.agentAuth = () => true
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/provision',
    body: { runtime: 'emulator' },
    headers: { 'x-dsh-phone-token': 'good-token' },
  })
  assert.equal(response.statusCode, 401)
  assert.equal(json(response).error.code, 'E_AUTH')
  assert.equal(harness.provisioner.requests.length, 0)
})
/* ------------------ issue #71：CAS revision / Agent 读 config / verify 收紧 ------------------ */

test('POST /config 与 /agent/config：缺少 revision → 400 E_BAD_REQUEST（不被静默 LWW）', async () => {
  const harness = makeHarness()
  let response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'userHint'], value: '没有 revision' },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')

  harness.connection = { requestRejection: () => 401 }
  harness.agentAuth = () => true
  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/agent/config',
    body: { path: ['attach', 'resolved'], value: false },
    headers: { 'x-dsh-phone-token': 'good-token' },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')
  assert.equal(harness.settings.calls, 0)
})

test('Agent token 可读 GET /config（取 revision 做 CAS），仍不能写 onboarding', async () => {
  const harness = makeHarness()
  harness.connection = { requestRejection: () => 401 }
  harness.agentAuth = (req) =>
    (req.headers as Record<string, string>)['x-dsh-phone-token'] === 'good-token'
  const config = await invoke(harness, {
    method: 'GET',
    url: '/dsh-phone/api/config',
    headers: { 'x-dsh-phone-token': 'good-token' },
  })
  assert.equal(config.statusCode, 200)
  assert.equal(json(config).value.revision, 5)
})

test('/attach/verify：只允许 loopback + 端口 ≥1024（防内网端口探测）', async () => {
  const harness = makeHarness()
  for (const endpoint of ['10.0.0.1:5555', '192.168.1.2:62001', '127.0.0.1:80', 'example.com:5555']) {
    const response = await invoke(harness, {
      method: 'POST',
      url: '/dsh-phone/api/attach/verify',
      body: { endpoint },
    })
    assert.equal(response.statusCode, 400, endpoint)
    assert.equal(json(response).error.code, 'E_BAD_REQUEST', endpoint)
  }
  for (const endpoint of ['127.0.0.1:5555', 'localhost:5555', '::1:5555']) {
    const response = await invoke(harness, {
      method: 'POST',
      url: '/dsh-phone/api/attach/verify',
      body: { endpoint },
    })
    assert.equal(response.statusCode, 200, endpoint)
    assert.equal(json(response).value.ok, true, endpoint)
  }
})

test('R5 verified 带 TTL：过期后写 endpoint/resolved → 409 E_NOT_VERIFIED', async () => {
  const harness = makeHarness()
  let response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/attach/verify',
    body: { endpoint: '127.0.0.1:5555' },
  })
  assert.equal(response.statusCode, 200)

  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'endpoint'], value: '127.0.0.1:5555', revision: 5 },
  })
  assert.equal(response.statusCode, 200)

  // 超过 TTL 后，verified 记录过期；resolved=true 必须重新 verify
  harness.now += VERIFY_TTL_MS + 1
  response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/config',
    body: { path: ['attach', 'resolved'], value: true, revision: 6 },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(json(response).error.code, 'E_NOT_VERIFIED')
})

test('safeGetOrigin：getOrigin 抛异常/缺失/空串 → 回退，不阻断 HTTP/WS 注册', () => {
  assert.equal(
    safeGetOrigin({
      getOrigin() {
        throw new Error('listen() 之前调用 getOrigin()')
      },
    }),
    'http://127.0.0.1',
  )
  assert.equal(safeGetOrigin({}), 'http://127.0.0.1')
  assert.equal(safeGetOrigin({ getOrigin: () => '' }), 'http://127.0.0.1')
  assert.equal(safeGetOrigin({ getOrigin: () => 'http://127.0.0.1:3096' }), 'http://127.0.0.1:3096')
})
/* ----------------------------- issue #83：生命周期 API ----------------------------- */

test('GET /runtime：返回状态/所有权/pid/endpoint/busy/lastError', async () => {
  const harness = makeHarness()
  harness.lifecycle.nextInfo = {
    state: 'running',
    running: true,
    owned: true,
    adopted: false,
    pid: 4321,
    endpoint: { host: '127.0.0.1', port: 5555 },
    since: 123,
    busy: false,
    lastError: 'note',
  }
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/runtime' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(json(response).value, harness.lifecycle.nextInfo)
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('POST /runtime：浏览器 start/stop/restart → 202 {ok,action,state} 且入队', async () => {
  const harness = makeHarness()
  harness.lifecycle.nextInfo = {
    state: 'running',
    running: true,
    owned: true,
    adopted: false,
    busy: false,
  }
  for (const action of ['start', 'stop', 'restart'] as const) {
    const response = await invoke(harness, {
      method: 'POST',
      url: '/dsh-phone/api/runtime',
      body: { action },
    })
    assert.equal(response.statusCode, 202, action)
    assert.deepEqual(json(response), { ok: true, action, state: 'running' }, action)
  }
  assert.deepEqual(harness.lifecycle.actions, ['start', 'stop', 'restart'])
})

test('POST /runtime：agent token 允许 start/restart 自愈，但 stop → 403', async () => {
  const harness = makeHarness()
  harness.connection = { requestRejection: () => 401 }
  harness.agentAuth = (req) =>
    (req.headers as Record<string, string>)['x-dsh-phone-token'] === 'good-token'
  const headers = { 'x-dsh-phone-token': 'good-token' }

  for (const action of ['start', 'restart']) {
    const response = await invoke(harness, {
      method: 'POST',
      url: '/dsh-phone/api/runtime',
      body: { action },
      headers,
    })
    assert.equal(response.statusCode, 202, action)
  }
  const stop = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/runtime',
    body: { action: 'stop' },
    headers,
  })
  assert.equal(stop.statusCode, 403)
  assert.equal(json(stop).error.code, 'E_FORBIDDEN')
  assert.deepEqual(harness.lifecycle.actions, ['start', 'restart'])
})

test('POST /runtime：非法 action → 400（不入队）', async () => {
  const harness = makeHarness()
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/runtime',
    body: { action: 'kill' },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).error.code, 'E_BAD_REQUEST')
  assert.deepEqual(harness.lifecycle.actions, [])
})

test('GET /status：兼容并补充 owned/adopted/pid（issue #83）', async () => {
  const service = makeService({
    status: async () => ({
      state: 'running',
      runtime: 'emulator',
      platform: 'linux',
      owned: true,
      adopted: false,
      pid: 999,
      since: 456,
    }),
  })
  const harness = makeHarness({ service })
  const response = await invoke(harness, { method: 'GET', url: '/dsh-phone/api/status' })
  assert.equal(response.statusCode, 200)
  const value = json(response).value
  assert.equal(value.owned, true)
  assert.equal(value.adopted, false)
  assert.equal(value.pid, 999)
  assert.equal(value.since, 456)
})
