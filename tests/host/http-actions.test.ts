import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeService } from './fakes.ts'
import { invoke, json, makeHarness } from './http-harness.ts'

/* ------------------------- issue #100：POST /action app-drawer ------------------------- */

test('POST /action：浏览器 app-drawer → ensureRunning + 固定命令 → 200 {ok:true}', async () => {
  const calls: string[] = []
  const service = makeService({
    ensureRunning: async () => {
      calls.push('ensureRunning')
    },
    shell: async (command, timeoutMs) => {
      calls.push('shell:' + command + '@' + (timeoutMs ?? 'default'))
      return 'Starting: Intent { cmp=com.dafeiyu.shell/.DrawerActivity }'
    },
  })
  const harness = makeHarness({ service })
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/action',
    body: { action: 'app-drawer' },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(json(response), { ok: true })
  assert.deepEqual(calls, [
    'ensureRunning',
    'shell:am start -n com.dafeiyu.shell/.DrawerActivity --activity-single-top@5000',
  ])
})

test('POST /action：agent token 允许（与浏览器同样执行固定命令）', async () => {
  const harness = makeHarness()
  harness.connection = { requestRejection: () => 401 }
  harness.agentAuth = (req) =>
    (req.headers as Record<string, string>)['x-dsh-phone-token'] === 'good-token'
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/action',
    body: { action: 'app-drawer' },
    headers: { 'x-dsh-phone-token': 'good-token' },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(json(response), { ok: true })
})

test('POST /action：未安装 DrawerActivity → 409 E_APP_DRAWER_UNAVAILABLE（不可重试，提示 provision）', async () => {
  const service = makeService({
    shell: async () => {
      throw new Error('Error type 3\nActivity class {com.dafeiyu.shell/.DrawerActivity} does not exist.')
    },
  })
  const harness = makeHarness({ service })
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/action',
    body: { action: 'app-drawer' },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(json(response).error.code, 'E_APP_DRAWER_UNAVAILABLE')
  assert.equal(json(response).error.retryable, false)
  assert.match(json(response).error.message, /provision-device\.sh/)
})

test('POST /action：am start 输出 Activity 不存在 → 409（输出侧检测）', async () => {
  const service = makeService({
    shell: async () => 'Error: Activity class {com.dafeiyu.shell/.DrawerActivity} does not exist.',
  })
  const harness = makeHarness({ service })
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/action',
    body: { action: 'app-drawer' },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(json(response).error.code, 'E_APP_DRAWER_UNAVAILABLE')
})

test('POST /action：5s 超时 → 409 E_APP_DRAWER_UNAVAILABLE（retryable=true）', async () => {
  const service = makeService({
    shell: async () => {
      throw Object.assign(new Error('shell 命令超时（5000ms）'), { code: 'timeout' })
    },
  })
  const harness = makeHarness({ service })
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/action',
    body: { action: 'app-drawer' },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(json(response).error.code, 'E_APP_DRAWER_UNAVAILABLE')
  assert.equal(json(response).error.retryable, true)
})

test('POST /action：生命周期 busy → 409 E_LIFECYCLE_BUSY（不执行命令）', async () => {
  const service = makeService()
  const harness = makeHarness({ service })
  harness.lifecycle.nextInfo = { ...harness.lifecycle.nextInfo, busy: true }
  const response = await invoke(harness, {
    method: 'POST',
    url: '/dsh-phone/api/action',
    body: { action: 'app-drawer' },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(json(response).error.code, 'E_LIFECYCLE_BUSY')
  assert.equal(service.calls.includes('shell:am start'), false)
})

test('POST /action：非法 action → 400（不执行命令）', async () => {
  const service = makeService()
  const harness = makeHarness({ service })
  for (const action of ['home', 'recents', 'rm -rf']) {
    const response = await invoke(harness, {
      method: 'POST',
      url: '/dsh-phone/api/action',
      body: { action },
    })
    assert.equal(response.statusCode, 400, action)
    assert.equal(json(response).error.code, 'E_BAD_REQUEST', action)
  }
  assert.equal(service.calls.some((call) => call.startsWith('shell:')), false)
})
