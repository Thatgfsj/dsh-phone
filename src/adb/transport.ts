/**
 * Tango ADB 传输层：纯 TypeScript 直连 `127.0.0.1:<port>` 的 adbd。
 *
 * 不经过 adb server、不依赖 adb 二进制（SPEC §3.2）。对外暴露
 * {@link AdbConnection}：文本/二进制 shell、sync push、幂等关闭、断连通知。
 */

import { Adb, AdbDaemonTransport } from '@yume-chan/adb'
import { ConcatBufferStream, ReadableStream } from '@yume-chan/stream-extra'

import { getDefaultCredentialStore } from './credentials.ts'
import { openTcpLink } from './tcp.ts'
import type { TcpAdbLink } from './tcp.ts'
import { withTimeout } from './timing.ts'
import {
  AdbError,
  AdbTimeoutError,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PUSH_TIMEOUT_MS,
  DEFAULT_SHELL_TIMEOUT_MS,
  endpointKey,
} from './types.ts'
import type {
  AdbConnectOptions,
  AdbConnection,
  Endpoint,
  PushOptions,
  ShellOptions,
} from './types.ts'

type ShellProcess = Awaited<
  ReturnType<Adb['subprocess']['noneProtocol']['spawn']>
>

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class TangoAdbConnection implements AdbConnection {
  readonly endpoint: Endpoint
  readonly adb: Adb
  readonly disconnected: Promise<void>
  readonly #link: TcpAdbLink
  #closing: Promise<void> | undefined

  constructor(endpoint: Endpoint, adb: Adb, link: TcpAdbLink) {
    this.endpoint = endpoint
    this.adb = adb
    this.#link = link
    this.disconnected = new Promise<void>((resolve) => {
      void adb.disconnected.then(
        () => resolve(),
        () => resolve(),
      )
    })
  }

  get serial(): string {
    return this.adb.serial
  }

  get raw(): Adb {
    return this.adb
  }

  async shell(command: string, options: ShellOptions = {}): Promise<string> {
    const bytes = await this.shellRaw(command, options)
    return new TextDecoder().decode(bytes)
  }

  shellRaw(command: string, options: ShellOptions = {}): Promise<Uint8Array> {
    return this.#run(command, options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS)
  }

  async push(
    local: Uint8Array,
    remotePath: string,
    options: PushOptions = {},
  ): Promise<void> {
    if (!remotePath.startsWith('/')) {
      throw new AdbError(
        `push 的远端路径必须是绝对路径: ${remotePath}`,
        'push',
      )
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    const remaining = () => Math.max(1, deadline - Date.now())

    let sync: Awaited<ReturnType<Adb['sync']>> | undefined
    try {
      sync = await withTimeout(
        this.adb.sync(),
        remaining(),
        () =>
          new AdbTimeoutError(`打开 sync 通道超时（${timeoutMs}ms）`, timeoutMs),
      )
      const file = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(local)
          controller.close()
        },
      })
      await withTimeout(
        sync.write({
          filename: remotePath,
          file: file as never,
          permission: 0o600,
          mtime: Math.floor(Date.now() / 1000),
        }),
        remaining(),
        () =>
          new AdbTimeoutError(
            `push ${remotePath} 超时（${timeoutMs}ms）`,
            timeoutMs,
          ),
        () => {
          void sync?.dispose()
        },
      )
    } catch (error) {
      if (error instanceof AdbError) throw error
      throw new AdbError(
        `push ${remotePath} 失败: ${failureMessage(error)}`,
        'push',
        { cause: error },
      )
    } finally {
      try {
        await sync?.dispose()
      } catch {
        // socket 可能已被超时逻辑关闭
      }
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      try {
        await this.adb.close()
      } catch {
        // 已经断开
      }
      this.#link.close()
    })()
    return this.#closing
  }

  async #run(command: string, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs
    const remaining = () => Math.max(1, deadline - Date.now())
    const timeoutError = () =>
      new AdbTimeoutError(
        `shell 命令超时（${timeoutMs}ms）: ${command}`,
        timeoutMs,
      )

    let process: ShellProcess | undefined
    try {
      process = await withTimeout(
        this.adb.subprocess.noneProtocol.spawn([command]),
        remaining(),
        timeoutError,
      )
      return await withTimeout(
        process.output.pipeThrough(new ConcatBufferStream()),
        remaining(),
        timeoutError,
        () => {
          void process?.kill()
        },
      )
    } catch (error) {
      void process?.kill()
      if (error instanceof AdbError) throw error
      throw new AdbError(
        `shell 执行失败: ${command}: ${failureMessage(error)}`,
        'shell',
        { cause: error },
      )
    }
  }
}

/**
 * 连接一个 adbd TCP 端点（TCP connect + ADB AUTH 握手）。
 *
 * 失败时抛 {@link AdbError}（`code=connect`）或
 * {@link AdbTimeoutError}（`code=timeout`）。
 */
export async function connect(
  endpoint: Endpoint,
  options: AdbConnectOptions = {},
): Promise<AdbConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  const address = endpointKey(endpoint)

  const link = await openTcpLink(endpoint, { timeoutMs: remaining() })
  let transport: Awaited<ReturnType<typeof AdbDaemonTransport.authenticate>>
  try {
    transport = await withTimeout(
      AdbDaemonTransport.authenticate({
        serial: address,
        connection: link.connection,
        credentialStore: options.credentialStore ?? getDefaultCredentialStore(),
      }),
      remaining(),
      () =>
        new AdbTimeoutError(
          `与 ${address} 的 ADB 认证握手超时（${timeoutMs}ms）`,
          timeoutMs,
        ),
      () => link.close(),
    )
  } catch (error) {
    link.close()
    if (error instanceof AdbError) throw error
    throw new AdbError(`ADB 握手失败（${address}）: ${failureMessage(error)}`, 'connect', {
      cause: error,
    })
  }

  return new TangoAdbConnection(endpoint, new Adb(transport), link)
}

/** 幂等断开连接。 */
export async function disconnect(connection: AdbConnection): Promise<void> {
  await connection.close()
}
