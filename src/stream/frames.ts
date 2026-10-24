/**
 * DPH1 WebSocket 二进制帧头（docs/protocol.md §2.2，冻结）。
 *
 * ```
 * byte 0..3  magic "DPH1"
 * byte 4..7  meta = u32 big-endian
 *            bits 31..28 frameType: 0=configuration 1=keyframe 2=delta 3=audio 4=control
 *            bits 27..0  pts @ 90kHz（模 2^28，约 2982s 回绕）
 * byte 8..   H.264 Annex-B 负载（与 scrcpy packet.data 逐字节一致）
 * ```
 *
 * Host 零转码：本模块只读 packet 元信息并拼接 8 字节头，不改动 payload 任何字节。
 */

import type { ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy'

export const FRAME_MAGIC = Object.freeze([0x44, 0x50, 0x48, 0x31] as const)
export const FRAME_HEADER_SIZE = 8
export const PTS_HZ = 90_000
export const PTS_MODULO = 2 ** 28
/** WS 单包上限；H.264 分片远小于该值，超出视为协议错误。 */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

/** frameType 编码（4 bit）。 */
export const FRAME_TYPE = Object.freeze({
  configuration: 0,
  keyframe: 1,
  delta: 2,
  audio: 3,
  control: 4,
} as const)

export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE]

/** scrcpy packet → DPH1 frameType。 */
export function frameTypeOf(packet: ScrcpyMediaStreamPacket): FrameType {
  if (packet.type === 'configuration') return FRAME_TYPE.configuration
  return packet.keyframe ? FRAME_TYPE.keyframe : FRAME_TYPE.delta
}

/**
 * 微秒 → 90kHz ticks（模 2^28）。
 *
 * scrcpy 的 pts 单位是微秒（服务端 frame meta）；1 tick = 1/90000 s。
 * 用整数运算避免浮点误差：ticks = round(us * 90 / 1e6) = round(us * 9 / 100)。
 */
export function microsToTicks(micros: bigint): number {
  const scaled = floorDiv(micros * 9n + 50n, 100n)
  return Number(modulo(scaled, BigInt(PTS_MODULO)))
}

/** 向下取整除法（BigInt 的 `/` 向零截断，负 pts 需要 floor）。 */
function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor
  return dividend % divisor !== 0n && (dividend < 0n) !== (divisor < 0n) ? quotient - 1n : quotient
}

function modulo(value: bigint, modulus: bigint): bigint {
  const result = value % modulus
  return result < 0n ? result + modulus : result
}

/** 生成 8 字节头；ptsTicks 会被规范化到 28 bit。 */
export function encodeFrameHeader(frameType: FrameType, ptsTicks: number | bigint): Uint8Array {
  if (!Number.isInteger(frameType) || frameType < 0 || frameType > 15) {
    throw new RangeError('frameType 必须在 0..15 之间: ' + String(frameType))
  }
  const ticks = Number(modulo(BigInt(Math.trunc(Number(ptsTicks))), BigInt(PTS_MODULO)))
  const meta = ((frameType & 0x0f) * 2 ** 28 + ticks) >>> 0
  const header = new Uint8Array(FRAME_HEADER_SIZE)
  header[0] = FRAME_MAGIC[0]
  header[1] = FRAME_MAGIC[1]
  header[2] = FRAME_MAGIC[2]
  header[3] = FRAME_MAGIC[3]
  new DataView(header.buffer).setUint32(4, meta, false)
  return header
}

export interface DecodedFrameHeader {
  frameType: FrameType
  ptsTicks: number
  /** 负载在输入 buffer 中的偏移（恒为 8）。 */
  payloadOffset: number
}

/** 解析 8 字节头；magic 不匹配时抛 RangeError。 */
export function decodeFrameHeader(bytes: Uint8Array): DecodedFrameHeader {
  if (bytes.byteLength < FRAME_HEADER_SIZE) {
    throw new RangeError('DPH1 帧头不足 8 字节: ' + bytes.byteLength)
  }
  if (
    bytes[0] !== FRAME_MAGIC[0] ||
    bytes[1] !== FRAME_MAGIC[1] ||
    bytes[2] !== FRAME_MAGIC[2] ||
    bytes[3] !== FRAME_MAGIC[3]
  ) {
    throw new RangeError('DPH1 magic 不匹配')
  }
  const meta = new DataView(bytes.buffer, bytes.byteOffset, FRAME_HEADER_SIZE).getUint32(4, false)
  return {
    frameType: (meta >>> 28) as FrameType,
    ptsTicks: meta & 0x0fffffff,
    payloadOffset: FRAME_HEADER_SIZE,
  }
}

/** 手动拼帧（供测试与诊断使用）。 */
export function encodeFrame(frameType: FrameType, ptsTicks: number | bigint, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError('视频负载过大: ' + payload.byteLength + ' > ' + MAX_PAYLOAD_BYTES)
  }
  const header = encodeFrameHeader(frameType, ptsTicks)
  const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength)
  frame.set(header, 0)
  frame.set(payload, FRAME_HEADER_SIZE)
  return frame
}

/**
 * scrcpy packet → DPH1 frame。
 *
 * configuration packet 没有 pts，使用调用方提供的 `fallbackTicks`（Host 单调时钟）；
 * data packet 优先用服务端 pts（微秒）换算。payload 原样拷贝，不做任何编码转换。
 */
export function encodePacket(
  packet: ScrcpyMediaStreamPacket,
  fallbackTicks: number | bigint,
): Uint8Array {
  const ticks =
    packet.type === 'data' && packet.pts !== undefined
      ? microsToTicks(packet.pts)
      : fallbackTicks
  return encodeFrame(frameTypeOf(packet), ticks, packet.data)
}

/** Host 侧 90kHz 单调时钟（避免依赖 Date.now 精度，跨调用不回退）。 */
export class StreamClock {
  #last = -1

  /** 返回下一次 ticks；nowMs 便于单测注入。 */
  next(nowMs: number = Date.now()): number {
    const ticks = microsToTicks(BigInt(Math.trunc(nowMs)) * 1000n)
    this.#last = this.#last < 0 || ticks > this.#last ? ticks : (this.#last + 1) % PTS_MODULO
    return this.#last
  }
}
