/**
 * TCP 直连 adbd：把 Node 的 TCP socket 适配成 Tango ADB 需要的
 * `ReadableWritablePair<AdbPacketData, Consumable<AdbPacketInit>>`。
 *
 * 关键点：adbd 的 TCP 通道是**裸 ADB 数据包流**（无 adb server 的
 * `OKAY`/`length` 帧），所以这里用 `StructDeserializeStream(AdbPacket)`
 * 做变长分帧，用 `AdbPacket.serialize` 做序列化。
 */

import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'

import { AdbPacket } from '@yume-chan/adb'
import type {
  AdbDaemonConnection,
  AdbPacketData,
  AdbPacketInit,
} from '@yume-chan/adb'
import { Consumable, StructDeserializeStream } from '@yume-chan/stream-extra'

import {
  AdbError,
  AdbTimeoutError,
  DEFAULT_CONNECT_TIMEOUT_MS,
  formatEndpoint,
} from './types.ts'
import type { Endpoint } from './types.ts'

/** 已建立的 TCP 链路（尚未完成 ADB 认证）。 */
export interface TcpAdbLink {
  readonly endpoint: Endpoint
  readonly connection: AdbDaemonConnection
  readonly socket: Socket
  /** 底层 socket 关闭时 resolve。 */
  readonly closed: Promise<void>
  /** 幂等关闭（destroy）。 */
  close(): void
}

export interface OpenTcpLinkOptions {
  timeoutMs?: number
}

function createConnection(socket: Socket): AdbDaemonConnection {
  // Node 的 socket → Web ReadableStream（Node 18+ 提供 toWeb）
  const bytes = Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>
  const readable = bytes.pipeThrough(
    new StructDeserializeStream(AdbPacket) as unknown as TransformStream<
      Uint8Array,
      AdbPacketData
    >,
  )

  const writable = new Consumable.WritableStream<AdbPacketInit>({
    async write(packet) {
      const serialized = AdbPacket.serialize(packet)
      socket.write(serialized)
    },
    close() {
      socket.end()
    },
    abort() {
      socket.destroy()
    },
  })

  return { readable, writable } as unknown as AdbDaemonConnection
}

function waitForConnect(
  socket: Socket,
  endpoint: Endpoint,
  timeoutMs: number,
): Promise<void> {
  const address = formatEndpoint(endpoint)
  return new Promise<void>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onConnect = () => finish()
    const onError = (error: Error) =>
      finish(
        new AdbError(`无法连接 ${address}: ${error.message}`, 'connect', {
          cause: error,
        }),
      )
    const timer = setTimeout(() => {
      socket.destroy()
      finish(
        new AdbTimeoutError(
          `连接 ${address} 超时（${timeoutMs}ms）；adbd 未就绪或实例未启动`,
          timeoutMs,
        ),
      )
    }, timeoutMs)
    timer.unref?.()

    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

export async function openTcpLink(
  endpoint: Endpoint,
  options: OpenTcpLinkOptions = {},
): Promise<TcpAdbLink> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const socket = netConnect({ host: endpoint.host, port: endpoint.port })
  socket.setNoDelay(true)
  // 永久 error 监听：连接建立后错误由 Web 流传播，避免 Node 抛出未捕获 'error'。
  socket.on('error', () => undefined)

  await waitForConnect(socket, endpoint, timeoutMs)

  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
  })

  return {
    endpoint,
    connection: createConnection(socket),
    socket,
    closed,
    close() {
      if (!socket.destroyed) socket.destroy()
    },
  }
}
