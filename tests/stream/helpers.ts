import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { FrameParser } from '../../src/stream/websocket.ts'

/** 假 Duplex：记录写入字节并暴露 ws 层需要的事件接口。 */
export class FakeSocket extends EventEmitter {
  written: (Uint8Array | string)[] = []
  destroyed = false
  writableLength = 0

  write(chunk: Uint8Array | string): boolean {
    this.written.push(chunk)
    return true
  }

  end(): void {
    this.emit('end')
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }

  asDuplex(): Duplex {
    return this as unknown as Duplex
  }

  /** 收到的文本（握手/HTTP 响应 + WS 文本帧分开看）。 */
  text(): string {
    return this.written
      .filter((item): item is string => typeof item === 'string')
      .join('')
  }

  bytes(): Uint8Array {
    const chunks = this.written.filter((item): item is Uint8Array => typeof item !== 'string')
    const total = chunks.reduce((sum, item) => sum + item.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  }
}

/** 解析服务端 → 客户端帧（无掩码）。 */
export function parseServerFrames(bytes: Uint8Array): { opcode: number; payload: Uint8Array }[] {
  const frames: { opcode: number; payload: Uint8Array }[] = []
  let offset = 0
  while (offset + 2 <= bytes.byteLength) {
    const b0 = bytes[offset] as number
    const b1 = bytes[offset + 1] as number
    let length = b1 & 0x7f
    let header = 2
    if (length === 126) {
      if (offset + 4 > bytes.byteLength) break
      length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number)
      header = 4
    } else if (length === 127) {
      if (offset + 10 > bytes.byteLength) break
      let big = 0n
      for (let i = 0; i < 8; i += 1) big = (big << 8n) | BigInt(bytes[offset + 2 + i] as number)
      length = Number(big)
      header = 10
    }
    const start = offset + header
    if (start + length > bytes.byteLength) break
    frames.push({ opcode: b0 & 0x0f, payload: bytes.subarray(start, start + length) })
    offset = start + length
  }
  return frames
}

export function textFrames(bytes: Uint8Array): Record<string, unknown>[] {
  return parseServerFrames(bytes)
    .filter((frame) => frame.opcode === 0x1)
    .map((frame) => JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>)
}

export function binaryFrames(bytes: Uint8Array): Uint8Array[] {
  return parseServerFrames(bytes)
    .filter((frame) => frame.opcode === 0x2)
    .map((frame) => frame.payload)
}

/** 构造客户端 → 服务端掩码帧。 */
export function clientFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const mask = [0x11, 0x22, 0x33, 0x44]
  const extended = payload.byteLength >= 126
  const maskOffset = extended ? 4 : 2
  const frame = new Uint8Array(maskOffset + 4 + payload.byteLength)
  frame[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  if (extended) {
    frame[1] = 0x80 | 126
    frame[2] = (payload.byteLength >>> 8) & 0xff
    frame[3] = payload.byteLength & 0xff
  } else {
    frame[1] = 0x80 | payload.byteLength
  }
  frame.set(mask, maskOffset)
  for (let i = 0; i < payload.byteLength; i += 1) {
    frame[maskOffset + 4 + i] = (payload[i] as number) ^ (mask[i & 3] as number)
  }
  return frame
}

export function textFrame(value: unknown): Uint8Array {
  return clientFrame(0x1, new TextEncoder().encode(JSON.stringify(value)))
}

export function makeUpgradeRequest(overrides: Record<string, string | undefined> = {}): IncomingMessage {
  const headers: Record<string, string | undefined> = {
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
    ...overrides,
  }
  return { headers } as unknown as IncomingMessage
}

/** 从 FrameParser 收到客户端帧（复用生产解析器做反向验证）。 */
export function parseClientFrame(frame: Uint8Array): Uint8Array {
  const parsed = new FrameParser().push(frame)
  return (parsed[0]?.payload ?? new Uint8Array(0))
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
