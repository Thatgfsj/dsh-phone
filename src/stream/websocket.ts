/**
 * 最小 RFC 6455 WebSocket 服务端实现（DSH 基线没有 ws 依赖）。
 *
 * 只实现 dsh-phone 需要的子集：同源升级、text/binary 消息、分片、ping/pong、
 * close（code + reason）。不协商子协议、不做压缩。
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = Object.freeze({
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const)
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

/** 握手失败（由路由层写 HTTP 响应并销毁 socket）。 */
export class WebSocketHandshakeError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'WebSocketHandshakeError'
    this.status = status
  }
}

/** RFC 6455 §4.2.2：Sec-WebSocket-Accept。 */
export function computeAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

export interface ParsedFrame {
  fin: boolean
  opcode: number
  payload: Uint8Array
}

/** 客户端 → 服务端帧解析（缓冲任意分块，逐帧吐出；处理掩码与 16/64 位长度）。 */
export class FrameParser {
  #buffer: Uint8Array = new Uint8Array(0)

  push(chunk: Uint8Array): ParsedFrame[] {
    if (chunk.byteLength > 0) {
      const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength)
      merged.set(this.#buffer, 0)
      merged.set(chunk, this.#buffer.byteLength)
      this.#buffer = merged
    }
    const frames: ParsedFrame[] = []
    for (;;) {
      const frame = this.#next()
      if (!frame) break
      frames.push(frame)
    }
    return frames
  }

  #next(): ParsedFrame | undefined {
    const buffer = this.#buffer
    if (buffer.byteLength < 2) return undefined
    const b0 = buffer[0] as number
    const b1 = buffer[1] as number
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.byteLength < 4) return undefined
      length = ((buffer[2] as number) << 8) | (buffer[3] as number)
      offset = 4
    } else if (length === 127) {
      if (buffer.byteLength < 10) return undefined
      let big = 0n
      for (let i = 0; i < 8; i += 1) big = (big << 8n) | BigInt(buffer[2 + i] as number)
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        throw new RangeError('WebSocket 帧过大: ' + big.toString())
      }
      length = Number(big)
      offset = 10
    }
    if (length > MAX_MESSAGE_BYTES) throw new RangeError('WebSocket 帧过大: ' + length)
    if (!masked) throw new RangeError('客户端帧必须使用掩码')
    if (buffer.byteLength < offset + 4 + length) return undefined
    const mask = buffer.subarray(offset, offset + 4)
    const payload = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      payload[i] = (buffer[offset + 4 + i] as number) ^ (mask[i & 3] as number)
    }
    this.#buffer = buffer.subarray(offset + 4 + length)
    return { fin, opcode, payload }
  }
}

/** 服务端 → 客户端帧编码（不掩码）。 */
export function encodeServerFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.byteLength
  let header: Uint8Array
  if (length < 126) {
    header = new Uint8Array(2)
    header[1] = length
  } else if (length < 65536) {
    header = new Uint8Array(4)
    header[1] = 126
    header[2] = (length >>> 8) & 0xff
    header[3] = length & 0xff
  } else {
    header = new Uint8Array(10)
    header[1] = 127
    let big = BigInt(length)
    for (let i = 9; i >= 2; i -= 1) {
      header[i] = Number(big & 0xffn)
      big >>= 8n
    }
  }
  header[0] = 0x80 | (opcode & 0x0f)
  const frame = new Uint8Array(header.byteLength + length)
  frame.set(header, 0)
  frame.set(payload, header.byteLength)
  return frame
}

/** 服务端连接：负责握手、收发帧、close 生命周期。 */
export class WebSocketConnection {
  #socket: Duplex
  #parser = new FrameParser()
  #closed = false
  #closeEmitted = false
  #fragmentOpcode: number | undefined
  #fragments: Uint8Array[] = []
  #fragmentBytes = 0
  #onMessage: ((kind: 'text' | 'binary', data: Uint8Array) => void) | undefined
  #onClose: ((code: number, reason: string) => void) | undefined

  private constructor(socket: Duplex) {
    this.#socket = socket
    socket.on('data', (chunk: Buffer) => this.#onData(new Uint8Array(chunk)))
    socket.on('close', () => this.#emitClose(1006, ''))
    socket.on('end', () => this.#emitClose(1006, ''))
    socket.on('error', () => this.#emitClose(1006, ''))
    this.#write(encodeServerFrame(OPCODE.ping, new Uint8Array(0)))
  }

  /** 校验升级请求并写握手响应；失败抛 WebSocketHandshakeError。 */
  static accept(req: IncomingMessage, socket: Duplex, head?: Buffer): WebSocketConnection {
    const connection = this.verify(req)
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || key.length === 0) {
      throw new WebSocketHandshakeError(400, 'missing Sec-WebSocket-Key')
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' +
        computeAcceptKey(key) +
        '\r\n\r\n',
    )
    const result = new WebSocketConnection(socket)
    if (head && head.byteLength > 0) result.#onData(new Uint8Array(head))
    return result
  }

  /** 只做握手请求校验（不写响应），便于路由层先鉴权再升级。 */
  static verify(req: IncomingMessage): void {
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
    const connection = String(req.headers.connection ?? '').toLowerCase()
    if (upgrade !== 'websocket' || !connection.split(',').some((item) => item.trim() === 'upgrade')) {
      throw new WebSocketHandshakeError(426, 'not a WebSocket upgrade')
    }
    if (req.headers['sec-websocket-version'] !== '13') {
      throw new WebSocketHandshakeError(426, 'unsupported WebSocket version')
    }
  }

  onMessage(handler: (kind: 'text' | 'binary', data: Uint8Array) => void): void {
    this.#onMessage = handler
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.#onClose = handler
  }

  get isOpen(): boolean {
    return !this.#closed
  }

  get bufferedBytes(): number {
    return this.#socket.writableLength ?? 0
  }

  sendText(text: string): void {
    this.#send(OPCODE.text, new TextEncoder().encode(text))
  }

  sendBinary(data: Uint8Array): void {
    this.#send(OPCODE.binary, data)
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return
    this.#closed = true
    const reasonBytes = new TextEncoder().encode(reason).subarray(0, 123)
    const payload = new Uint8Array(2 + reasonBytes.byteLength)
    payload[0] = (code >>> 8) & 0xff
    payload[1] = code & 0xff
    payload.set(reasonBytes, 2)
    this.#write(encodeServerFrame(OPCODE.close, payload))
    const socket = this.#socket
    // 先发 close 回调再 end：end 会同步触发 'end' → 1006，必须先认领正常 code。
    this.#emitClose(code, reason)
    socket.end()
    const timer = setTimeout(() => socket.destroy(), 1000)
    timer.unref?.()
  }

  destroy(): void {
    this.#closed = true
    this.#socket.destroy()
    this.#emitClose(1006, '')
  }

  #send(opcode: number, payload: Uint8Array): void {
    if (this.#closed || this.#socket.destroyed) return
    this.#write(encodeServerFrame(opcode, payload))
  }

  #write(frame: Uint8Array): void {
    if (this.#socket.destroyed) return
    this.#socket.write(frame)
  }

  #onData(chunk: Uint8Array): void {
    if (this.#closed) return
    let frames: ParsedFrame[]
    try {
      frames = this.#parser.push(chunk)
    } catch (error) {
      this.close(1002, error instanceof Error ? error.message : 'protocol error')
      return
    }
    for (const frame of frames) this.#handleFrame(frame)
  }

  #handleFrame(frame: ParsedFrame): void {
    if (frame.opcode >= 0x8) {
      if (frame.payload.byteLength > 125) {
        this.close(1002, 'control frame too large')
        return
      }
      if (frame.opcode === OPCODE.ping) {
        this.#send(OPCODE.pong, frame.payload)
      } else if (frame.opcode === OPCODE.close) {
        const code = frame.payload.byteLength >= 2
          ? ((frame.payload[0] as number) << 8) | (frame.payload[1] as number)
          : 1005
        const reason = frame.payload.byteLength > 2
          ? new TextDecoder().decode(frame.payload.subarray(2))
          : ''
        this.close(code === 1005 ? 1000 : code, reason)
      }
      return
    }
    if (frame.opcode === OPCODE.continuation) {
      if (this.#fragmentOpcode === undefined) {
        this.close(1002, 'unexpected continuation frame')
        return
      }
      this.#appendFragment(frame.payload)
      if (frame.fin) this.#finishFragments()
      return
    }
    if (frame.opcode !== OPCODE.text && frame.opcode !== OPCODE.binary) {
      this.close(1002, 'unknown opcode')
      return
    }
    if (this.#fragmentOpcode !== undefined) {
      this.close(1002, 'nested fragmented message')
      return
    }
    if (frame.fin) {
      this.#emitMessage(frame.opcode, frame.payload)
      return
    }
    this.#fragmentOpcode = frame.opcode
    this.#fragments = []
    this.#fragmentBytes = 0
    this.#appendFragment(frame.payload)
  }

  #appendFragment(payload: Uint8Array): void {
    this.#fragmentBytes += payload.byteLength
    if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
      this.close(1009, 'message too large')
      return
    }
    this.#fragments.push(payload)
  }

  #finishFragments(): void {
    const opcode = this.#fragmentOpcode
    const fragments = this.#fragments
    this.#fragmentOpcode = undefined
    this.#fragments = []
    this.#fragmentBytes = 0
    if (opcode === undefined) return
    const total = fragments.reduce((sum, part) => sum + part.byteLength, 0)
    const payload = new Uint8Array(total)
    let offset = 0
    for (const part of fragments) {
      payload.set(part, offset)
      offset += part.byteLength
    }
    this.#emitMessage(opcode, payload)
  }

  #emitMessage(opcode: number, payload: Uint8Array): void {
    try {
      this.#onMessage?.(opcode === OPCODE.text ? 'text' : 'binary', payload)
    } catch {
      this.close(1011, 'message handler failed')
    }
  }

  #emitClose(code: number, reason: string): void {
    if (this.#closeEmitted) return
    this.#closeEmitted = true
    this.#closed = true
    try {
      this.#onClose?.(code, reason)
    } catch {
      // close 回调不得向外抛错，避免进程崩溃。
    }
  }
}

export { OPCODE }
