/**
 * 假 adbd TCP 服务器：在 localhost 上实现 ADB 守护进程协议的最小子集，
 * 用来在没有真机/模拟器的情况下端到端验证 `src/adb/transport.ts`。
 *
 * 支持：
 * - CNXN 握手（可选 AUTH token/signature 流程）
 * - `exec:<cmd>` / `shell:<cmd>` 服务：由测试提供命令处理函数
 * - `sync:` 服务的 v1 SEND（push 文件）
 *
 * 不解码、不校验真实 RSA 签名（只看 AUTH 包是否到达）。
 */

import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'

import { AdbPacket } from '@yume-chan/adb'
import type { AdbPacketInit } from '@yume-chan/adb'

import type { Endpoint } from '../../src/adb/types.ts'

const ADB_COMMAND = {
  Auth: 0x48545541,
  Close: 0x45534c43,
  Connect: 0x4e584e43,
  Okay: 0x59414b4f,
  Open: 0x4e45504f,
  Write: 0x45545257,
} as const

const AUTH_TOKEN = 1
const AUTH_SIGNATURE = 2
const AUTH_PUBLIC_KEY = 3
const VERSION = 0x01000001
const SERVER_MAX_PAYLOAD = 256 * 1024
const SYNC_OKAY = Buffer.from('OKAY', 'ascii')
const SYNC_ID = {
  Send: encodeId('SEND'),
  Data: encodeId('DATA'),
  Done: encodeId('DONE'),
}

function encodeId(text: string): number {
  return (
    text.charCodeAt(0) |
    (text.charCodeAt(1) << 8) |
    (text.charCodeAt(2) << 16) |
    (text.charCodeAt(3) << 24)
  ) >>> 0
}

interface Packet {
  command: number
  arg0: number
  arg1: number
  payload: Buffer
}

export interface FakeShellResult {
  output: Uint8Array | string
  /** 非 0 时输出末尾附加 shell 层错误文本（none 协议不支持退出码）。 */
  stderr?: string
}

export interface FakeAdbdOptions {
  banner?: string
  /** `none`：直接 CNXN；`signature`：先发 AUTH token，等客户端签名后再 CNXN。 */
  auth?: 'none' | 'signature'
  /** shell 命令处理：service 去掉 `exec:`/`shell:` 前缀后的字符串。 */
  shell?: (command: string) => FakeShellResult | Promise<FakeShellResult>
  /** 调试钩子：收到每个 ADB 包时调用。 */
  onPacket?: (packet: Packet) => void
}

export interface FakePushedFile {
  path: string
  data: Buffer
}

const DEFAULT_BANNER =
  'device::ro.product.name=fake;ro.product.model=DshPhoneFake;ro.product.device=fake;' +
  'features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,abb_exec,remount_shell,track_app'

function encodePacket(init: AdbPacketInit): Buffer {
  return Buffer.from(AdbPacket.serialize(init))
}

function takePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = []
  let offset = 0
  while (buffer.length - offset >= 24) {
    const payloadLength = buffer.readUInt32LE(offset + 12)
    const total = 24 + payloadLength
    if (buffer.length - offset < total) break
    packets.push({
      command: buffer.readUInt32LE(offset),
      arg0: buffer.readUInt32LE(offset + 4),
      arg1: buffer.readUInt32LE(offset + 8),
      payload: buffer.subarray(offset + 24, offset + total),
    })
    offset += total
  }
  return { packets, rest: buffer.subarray(offset) }
}

interface SocketState {
  remoteId: number
  service: string
  pending: Buffer
  sync: { path?: string; chunks: Buffer[] } | undefined
}

export class FakeAdbdServer {
  readonly #server: Server
  readonly #options: FakeAdbdOptions
  readonly #sockets = new Set<Socket>()
  readonly requests: string[] = []
  readonly pushedFiles: FakePushedFile[] = []
  #authRequests = 0
  #token = new TextEncoder().encode('0123456789abcdefghij')

  private constructor(server: Server, options: FakeAdbdOptions) {
    this.#server = server
    this.#options = options
  }

  static async start(options: FakeAdbdOptions = {}): Promise<FakeAdbdServer> {
    const instance = new FakeAdbdServer(
      createServer((socket) => instance.#accept(socket)),
      options,
    )
    await new Promise<void>((resolve) => {
      instance.#server.listen(0, '127.0.0.1', () => resolve())
    })
    return instance
  }

  get endpoint(): Endpoint {
    const address = this.#server.address() as AddressInfo
    return { host: '127.0.0.1', port: address.port }
  }

  /** 收到 AUTH token/signature 包的次数（验证握手路径）。 */
  get authRequests(): number {
    return this.#authRequests
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve())
    })
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket)
    let buffer: Buffer = Buffer.alloc(0)
    let authenticated = this.#options.auth !== 'signature'
    const sockets = new Map<number, SocketState>()

    const send = (init: Omit<AdbPacketInit, 'checksum' | 'magic'>) => {
      if (socket.destroyed) return
      socket.write(
        encodePacket({
          ...init,
          payload: Buffer.from(init.payload),
          checksum: 0,
          magic: (init.command ^ 0xffffffff) >>> 0,
        }),
      )
    }
    const sendConnect = () => {
      send({
        command: ADB_COMMAND.Connect,
        arg0: VERSION,
        arg1: SERVER_MAX_PAYLOAD,
        payload: Buffer.from(this.#options.banner ?? DEFAULT_BANNER),
      })
    }
    const sendOkay = (localId: number, remoteId: number) => {
      send({ command: ADB_COMMAND.Okay, arg0: remoteId, arg1: localId, payload: Buffer.alloc(0) })
    }
    const sendWrite = (localId: number, remoteId: number, payload: Buffer) => {
      send({ command: ADB_COMMAND.Write, arg0: remoteId, arg1: localId, payload })
    }
    const sendClose = (localId: number, remoteId: number) => {
      send({ command: ADB_COMMAND.Close, arg0: remoteId, arg1: localId, payload: Buffer.alloc(0) })
    }

    const handleShell = async (localId: number, state: SocketState) => {
      const command = state.service.replace(/^(exec|shell|shell,raw):/, '')
      this.requests.push(command)
      const result = await this.#options.shell?.(command)
      const output =
        typeof result?.output === 'string'
          ? Buffer.from(result.output, 'utf8')
          : Buffer.from(result?.output ?? new Uint8Array(0))
      const stderr = result?.stderr ? Buffer.from(result.stderr, 'utf8') : undefined
      for (let offset = 0; offset < output.length; offset += 16 * 1024) {
        sendWrite(localId, state.remoteId, output.subarray(offset, offset + 16 * 1024))
      }
      if (stderr) sendWrite(localId, state.remoteId, stderr)
      sendClose(localId, state.remoteId)
    }

    const handleSyncData = (localId: number, state: SocketState, chunk: Buffer) => {
      state.pending = Buffer.concat([state.pending, chunk])
      const sync = (state.sync ??= { chunks: [] })
      for (;;) {
        if (state.pending.length < 8) return
        const id = state.pending.readUInt32LE(0)
        const length = state.pending.readUInt32LE(4)
        if (id === SYNC_ID.Send) {
          if (state.pending.length < 8 + length) return
          const pathAndMode = state.pending.subarray(8, 8 + length).toString('utf8')
          sync.path = pathAndMode.slice(0, pathAndMode.lastIndexOf(','))
          sync.chunks = []
          state.pending = state.pending.subarray(8 + length)
        } else if (id === SYNC_ID.Data) {
          if (state.pending.length < 8 + length) return
          sync.chunks.push(Buffer.from(state.pending.subarray(8, 8 + length)))
          state.pending = state.pending.subarray(8 + length)
        } else if (id === SYNC_ID.Done) {
          if (state.pending.length < 8) return
          state.pending = state.pending.subarray(8)
          if (sync.path) {
            this.pushedFiles.push({ path: sync.path, data: Buffer.concat(sync.chunks) })
          }
          sync.path = undefined
          const response = Buffer.alloc(8)
          SYNC_OKAY.copy(response, 0)
          response.writeUInt32LE(0, 4)
          sendWrite(localId, state.remoteId, response)
        } else {
          state.pending = Buffer.alloc(0)
          return
        }
      }
    }

    socket.on('error', () => undefined)
    socket.on('close', () => {
      this.#sockets.delete(socket)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const parsed = takePackets(buffer)
      buffer = parsed.rest
      for (const packet of parsed.packets) {
        this.#options.onPacket?.(packet)
        if (packet.command === ADB_COMMAND.Connect) {
          if (authenticated) {
            sendConnect()
          } else {
            this.#authRequests += 1
            send({ command: ADB_COMMAND.Auth, arg0: AUTH_TOKEN, arg1: 0, payload: this.#token })
          }
          continue
        }
        if (packet.command === ADB_COMMAND.Auth) {
          this.#authRequests += 1
          if (packet.arg0 === AUTH_SIGNATURE || packet.arg0 === AUTH_PUBLIC_KEY) {
            authenticated = true
            sendConnect()
          } else {
            send({ command: ADB_COMMAND.Auth, arg0: AUTH_TOKEN, arg1: 0, payload: this.#token })
          }
          continue
        }
        if (packet.command === ADB_COMMAND.Open) {
          const localId = packet.arg0
          const service = packet.payload.toString('utf8').replace(/\0$/, '')
          const state: SocketState = {
            remoteId: localId + 1000,
            service,
            pending: Buffer.alloc(0),
            sync: undefined,
          }
          sockets.set(localId, state)
          sendOkay(localId, state.remoteId)
          if (service === 'sync:') {
            state.sync = { chunks: [] }
          } else {
            void handleShell(localId, state)
          }
          continue
        }
        if (packet.command === ADB_COMMAND.Write) {
          const state = sockets.get(packet.arg0)
          if (!state) continue
          if (state.service === 'sync:') {
            handleSyncData(packet.arg0, state, packet.payload)
          }
          // 真实 adbd 在收到 WRTE 后回 OKAY（delayed-ack 关闭时 payload 为空），
          // 否则客户端会阻塞在可用写字节数上（Tango 的流控）。
          sendOkay(packet.arg0, state.remoteId)
          continue
        }
        if (packet.command === ADB_COMMAND.Close) {
          sockets.delete(packet.arg1)
          continue
        }
      }
    })
  }
}
