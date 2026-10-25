import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import { after, before, describe, test } from 'node:test'

import { runEmulatorConsoleCommand } from '../../src/runtime/emulator-console.ts'

interface FakeConsole {
  server: Server
  port: number
  commands: string[]
  close(): Promise<void>
}

async function startFakeConsole(options: {
  token?: string
  authRequired?: boolean
  silentCommand?: boolean
  commandReply?: string
}): Promise<FakeConsole> {
  const commands: string[] = []
  const server = createServer((socket) => {
    socket.write('Android Console: type auth to authenticate\r\nOK\r\n')
    let authed = options.authRequired !== true
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (!line) continue
        commands.push(line)
        if (line === 'quit') {
          socket.end()
          return
        }
        if (line.startsWith('auth ')) {
          if (options.token !== undefined && line.slice(5).trim() === options.token) {
            authed = true
            socket.write('OK\r\n')
          } else {
            socket.write('KO: wrong token\r\n')
          }
          continue
        }
        if (!authed) {
          socket.write('KO: not authenticated\r\n')
          continue
        }
        if (options.silentCommand === true) continue
        socket.write(options.commandReply ?? 'OK\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    server,
    port: (server.address() as AddressInfo).port,
    commands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('emulator console（issue #67，用于主动保存 quick-boot 快照）', () => {
  test('带 auth token 执行 avd snapshot save → OK', async () => {
    const console = await startFakeConsole({ token: 'secret', authRequired: true })
    try {
      const result = await runEmulatorConsoleCommand({
        port: console.port,
        command: 'avd snapshot save default_boot',
        authToken: 'secret',
        timeoutMs: 2_000,
      })
      assert.equal(result.ok, true)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.ok(console.commands.includes('auth secret'))
      assert.ok(console.commands.includes('avd snapshot save default_boot'))
    } finally {
      await console.close()
    }
  })

  test('token 错误 → ok:false 且不发送命令', async () => {
    const console = await startFakeConsole({ token: 'secret', authRequired: true })
    try {
      const result = await runEmulatorConsoleCommand({
        port: console.port,
        command: 'avd snapshot save default_boot',
        authToken: 'bad',
        timeoutMs: 1_000,
      })
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /wrong token/)
      assert.equal(console.commands.includes('avd snapshot save default_boot'), false)
    } finally {
      await console.close()
    }
  })

  test('命令无应答 → 超时失败（best-effort，不抛错）', async () => {
    const console = await startFakeConsole({ silentCommand: true })
    try {
      const startedAt = Date.now()
      const result = await runEmulatorConsoleCommand({
        port: console.port,
        command: 'avd snapshot save default_boot',
        timeoutMs: 300,
      })
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /超时/)
      assert.ok(Date.now() - startedAt >= 250)
    } finally {
      await console.close()
    }
  })

  test('console 不可达 → ok:false（调用方按 best-effort 处理）', async () => {
    const console = await startFakeConsole({})
    const port = console.port
    await console.close()
    const result = await runEmulatorConsoleCommand({
      port,
      command: 'avd snapshot save default_boot',
      timeoutMs: 500,
    })
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  })
})
