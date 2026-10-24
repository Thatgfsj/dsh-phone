import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { createFileCredentialStore } from '../../src/adb/credentials.ts'
import { connect } from '../../src/adb/transport.ts'
import { AdbError, AdbTimeoutError } from '../../src/adb/types.ts'
import type { AdbConnection } from '../../src/adb/types.ts'
import { FakeAdbdServer } from '../fake-adb/server.ts'

const BINARY = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x89, 0x50, 0x4e, 0x47])

async function makeCredentials(): Promise<{ dir: string; store: ReturnType<typeof createFileCredentialStore> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-phone-adb-'))
  return { dir, store: createFileCredentialStore({ dir }) }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('adb transport（假 adbd TCP 服务器）', () => {
  let server: FakeAdbdServer
  let credentialsDir: string
  let connection: AdbConnection | undefined

  before(async () => {
    server = await FakeAdbdServer.start({
      shell: (command) => {
        if (command.startsWith('screencap')) return { output: '' }
        if (command.startsWith('base64')) return { output: 'iVBORw0KGgo=' }
        if (command === 'fail') return { output: '', stderr: 'sh: fail: not found\n' }
        if (command === 'raw-bytes') return { output: BINARY }
        return { output: `echo:${command}\n` }
      },
    })
  })

  after(async () => {
    await connection?.close()
    await server.close()
  })

  test('connect 后可以执行文本 shell', async () => {
    const { dir, store } = await makeCredentials()
    credentialsDir = dir
    connection = await connect(server.endpoint, { credentialStore: store, timeoutMs: 3_000 })
    const output = await connection.shell('getprop ro.product.model')
    assert.equal(output, 'echo:getprop ro.product.model\n')
    assert.equal(connection.serial, `${server.endpoint.host}:${server.endpoint.port}`)
  })

  test('shellRaw 返回设备原始字节（含 0x00/0xff）', async () => {
    assert.ok(connection)
    const raw = await connection.shellRaw('raw-bytes')
    assert.deepEqual([...raw], [...BINARY])
  })

  test('push 通过 sync 协议写入设备文件', async () => {
    assert.ok(connection)
    const before = server.pushedFiles.length
    await connection.push(BINARY, '/data/local/tmp/scrcpy-server.jar')
    assert.equal(server.pushedFiles.length, before + 1)
    const pushed = server.pushedFiles[server.pushedFiles.length - 1]!
    assert.equal(pushed.path, '/data/local/tmp/scrcpy-server.jar')
    assert.deepEqual([...pushed.data], [...BINARY])
  })

  test('close 幂等，且断开后 disconnected resolve', async () => {
    assert.ok(connection)
    await connection.close()
    await connection.close()
    await Promise.race([
      connection.disconnected.then(() => undefined),
      delay(2_000).then(() => {
        throw new Error('disconnected 未在 2s 内 resolve')
      }),
    ])
    await rm(credentialsDir, { recursive: true, force: true })
  })
})

describe('adb transport：AUTH 握手', () => {
  test('auth=signature 时走 RSA 签名鉴权', async () => {
    const { dir, store } = await makeCredentials()
    const server = await FakeAdbdServer.start({
      auth: 'signature',
      shell: (command) => ({ output: `ok:${command}\n` }),
    })
    const connection = await connect(server.endpoint, { credentialStore: store, timeoutMs: 5_000 })
    assert.equal(await connection.shell('echo hi'), 'ok:echo hi\n')
    assert.ok(server.authRequests >= 2, `应经历 token+signature，实际 ${server.authRequests}`)
    await connection.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  test('设备返回错误文本（stderr 混入 stdout）', async () => {
    const { dir, store } = await makeCredentials()
    const server = await FakeAdbdServer.start({ shell: () => ({ output: '', stderr: 'sh: fail: not found\n' }) })
    const connection = await connect(server.endpoint, { credentialStore: store, timeoutMs: 5_000 })
    const output = await connection.shell('fail')
    assert.match(output, /not found/)
    await connection.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('adb transport：失败路径', () => {
  test('端口无人监听时抛 connect 错误', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const address = probe.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    await assert.rejects(
      connect({ host: '127.0.0.1', port }, { timeoutMs: 2_000 }),
      (error: unknown) => {
        assert.ok(error instanceof AdbError)
        assert.equal(error.code, 'connect')
        return true
      },
    )
  })

  test('对端接受 TCP 但不说话 → 握手超时', async () => {
    const silent: Server = createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    const address = silent.address()
    assert.ok(address && typeof address === 'object')
    const { dir, store } = await makeCredentials()
    try {
      await assert.rejects(
        connect({ host: '127.0.0.1', port: address.port }, { credentialStore: store, timeoutMs: 250 }),
        AdbTimeoutError,
      )
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('shell 卡住时按 timeoutMs 抛 AdbTimeoutError', async () => {
    const { dir, store } = await makeCredentials()
    const server = await FakeAdbdServer.start({
      shell: () => new Promise(() => undefined),
    })
    const connection = await connect(server.endpoint, { credentialStore: store, timeoutMs: 5_000 })
    await assert.rejects(connection.shell('sleep 9999', { timeoutMs: 200 }), AdbTimeoutError)
    await connection.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })
})
