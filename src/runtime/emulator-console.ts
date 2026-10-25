/**
 * emulator console 客户端（issue #67）：用于主动保存 quick-boot 快照。
 *
 * emulator 的 console 是 telnet 风格的纯文本协议（默认在 console 端口，即 adb 端口 - 1）：
 * - 连接后输出 banner，并以 "OK" 行结束；
 * - 需要认证时发送 `auth <token>`（token 在 ~/.emulator_console_auth_token）；
 * - 每条命令的应答以 "OK" 结束，失败为 "KO: ..."。
 *
 * 这里只实现「发一条命令并等 OK」，供 `avd snapshot save default_boot` 使用。
 * 失败不影响主流程（退出时的 SIGTERM 保存仍是兜底）。
 */

import { connect } from 'node:net'
import type { Socket } from 'node:net'

export interface ConsoleCommandResult {
  ok: boolean
  output: string
  error?: string
}

export interface ConsoleCommandOptions {
  /** console 端口（emulator -port 的值，adb 端口 - 1）。 */
  port: number
  /** 要执行的命令，如 `avd snapshot save default_boot`。 */
  command: string
  /** 认证 token（~/.emulator_console_auth_token 内容）；无认证需求时可省略。 */
  authToken?: string
  host?: string
  /** 命令应答等待上限（快照保存可能需要数秒），默认 90s。 */
  timeoutMs?: number
  /** 注入连接函数（单测用假 console server / 假 socket）。 */
  openConnection?: (options: { host: string; port: number }) => Socket
}

const GREETING_TIMEOUT_MS = 5_000
const AUTH_TIMEOUT_MS = 5_000

interface PendingReader {
  waitForOk(timeoutMs: number): Promise<{ ok: boolean; output: string; error?: string }>
  dispose(): void
}

function createReader(socket: Socket): PendingReader {
  let buffer = ''
  let waiter: { resolve: (value: { ok: boolean; output: string; error?: string }) => void } | undefined
  let settled = false

  const settle = (result: { ok: boolean; output: string; error?: string }) => {
    if (settled) return
    settled = true
    waiter?.resolve(result)
    waiter = undefined
  }

  const inspect = () => {
    if (!waiter) return
    const ko = /(^|\r?\n)KO:([^\r\n]*)/.exec(buffer)
    if (ko) {
      settle({ ok: false, output: buffer, error: (ko[2] ?? '').trim() || 'console 返回 KO' })
      return
    }
    if (/(^|\r?\n)OK\r?\n/.test(buffer)) {
      settle({ ok: true, output: buffer })
    }
  }

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString()
    inspect()
  }
  socket.on('data', onData)
  socket.on('error', (error) => settle({ ok: false, output: buffer, error: error.message }))
  socket.on('close', () => {
    // 已经收到 OK 的正常关闭不覆盖结果
    if (waiter) settle({ ok: false, output: buffer, error: 'console 连接已关闭' })
  })

  return {
    waitForOk(timeoutMs: number) {
      settled = false
      // 上一次应答的 OK/KO 不能影响这一次等待
      buffer = ''
      return new Promise((resolve) => {
        waiter = { resolve }
        const timer = setTimeout(() => {
          settle({ ok: false, output: buffer, error: 'console 等待超时（' + timeoutMs + 'ms）' })
        }, timeoutMs)
        timer.unref?.()
        const original = waiter.resolve
        waiter.resolve = (value) => {
          clearTimeout(timer)
          original(value)
        }
        inspect()
      })
    },
    dispose() {
      socket.off('data', onData)
      socket.destroy()
    },
  }
}

/** 发送一条 console 命令；失败返回 `{ok:false}`，不抛错（调用方 best-effort）。 */
export async function runEmulatorConsoleCommand(
  options: ConsoleCommandOptions,
): Promise<ConsoleCommandResult> {
  const host = options.host ?? '127.0.0.1'
  const timeoutMs = options.timeoutMs ?? 90_000
  const open =
    options.openConnection ??
    ((target: { host: string; port: number }) =>
      connect({ host: target.host, port: target.port }))

  let socket: Socket | undefined
  try {
    socket = open({ host, port: options.port })
    socket.setNoDelay(true)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('console 连接超时')), GREETING_TIMEOUT_MS)
      timer.unref?.()
      socket!.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket!.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    const reader = createReader(socket)
    const greeting = await reader.waitForOk(GREETING_TIMEOUT_MS)
    if (!greeting.ok) {
      reader.dispose()
      return greeting
    }

    if (options.authToken !== undefined && options.authToken !== '') {
      socket.write('auth ' + options.authToken + '\r\n')
      const auth = await reader.waitForOk(AUTH_TIMEOUT_MS)
      if (!auth.ok) {
        reader.dispose()
        return auth
      }
    }

    socket.write(options.command + '\r\n')
    const result = await reader.waitForOk(timeoutMs)
    socket.write('quit\r\n')
    reader.dispose()
    return result
  } catch (error) {
    socket?.destroy()
    return {
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
