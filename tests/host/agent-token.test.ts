import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  AGENT_TOKEN_HEADER,
  AgentTokenStore,
  generateAgentToken,
  isLoopbackAddress,
  resolveAgentTokenPath,
} from '../../src/config/agent-token.ts'

async function makeStore(): Promise<{ store: AgentTokenStore; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-phone-token-'))
  const filePath = join(dir, 'agent.json')
  return { store: new AgentTokenStore({ filePath }), filePath }
}

function request(options: {
  token?: string
  origin?: string
  remoteAddress?: string
}) {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers[AGENT_TOKEN_HEADER] = options.token
  if (options.origin !== undefined) headers.origin = options.origin
  return { headers, socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' } }
}

test('resolveAgentTokenPath：$DSH_HOME/storages/dsh-phone/agent.json', () => {
  assert.equal(
    resolveAgentTokenPath({ DSH_HOME: '/tmp/dsh-home' }),
    '/tmp/dsh-home/storages/dsh-phone/agent.json',
  )
  assert.match(resolveAgentTokenPath({}), /[\\/]\.dsh[\\/]storages[\\/]dsh-phone[\\/]agent\.json$/)
})

test('prepare：落盘 0600、token 64 位 hex、baseUrl 可回读', async () => {
  const { store, filePath } = await makeStore()
  await store.prepare('http://127.0.0.1:3080')
  const file = await store.readFile()
  assert.ok(file)
  assert.match(file.token, /^[0-9a-f]{64}$/)
  assert.equal(file.baseUrl, 'http://127.0.0.1:3080')
  const mode = (await stat(filePath)).mode & 0o777
  assert.equal(mode, 0o600)
  // 文件内容与内存 token 一致
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as { token: string }
  assert.equal(raw.token, file.token)
  assert.notEqual(generateAgentToken(), raw.token)
})

test('verifyRequest：loopback + 无 Origin + token 匹配才放行', async () => {
  const { store } = await makeStore()
  await store.prepare('http://127.0.0.1:3080')
  const token = store.info!.token

  assert.equal(await store.verifyRequest(request({ token })), true)
  assert.equal(await store.verifyRequest(request({ token, remoteAddress: '::1' })), true)
  assert.equal(await store.verifyRequest(request({ token, remoteAddress: '::ffff:127.0.0.1' })), true)

  assert.equal(await store.verifyRequest(request({ token: 'deadbeef' })), false)
  assert.equal(await store.verifyRequest(request({})), false)
  assert.equal(await store.verifyRequest(request({ token, remoteAddress: '192.168.1.2' })), false)
  assert.equal(
    await store.verifyRequest(request({ token, origin: 'http://127.0.0.1:3080' })),
    false,
  )
})

test('isLoopbackAddress：127/8、::1、映射地址', () => {
  assert.ok(isLoopbackAddress('127.0.0.1'))
  assert.ok(isLoopbackAddress('127.1.2.3'))
  assert.ok(isLoopbackAddress('::1'))
  assert.ok(isLoopbackAddress('::ffff:127.0.0.1'))
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('dispose：删除 token 文件（可重复调用）', async () => {
  const { store, filePath } = await makeStore()
  await store.prepare('http://127.0.0.1:3080')
  await store.dispose()
  assert.equal(await store.readFile(), undefined)
  await store.dispose()
})
