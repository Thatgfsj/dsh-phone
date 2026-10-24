/**
 * H.264 Annex-B helpers shared by both decode paths (docs/protocol.md §2.2).
 *
 * The Host forwards scrcpy's H.264 byte stream untouched, so the client has to
 * understand Annex-B framing: split NAL units for the software decoder, derive
 * the WebCodecs codec string from SPS, and build WebCodecs chunk descriptors.
 *
 * WebCodecs AVC format: this client configures the decoder with
 * `avc: { format: 'annexb' }` and no `description`, so the bitstream stays
 * Annex-B end to end (the Host does zero transcoding). The configuration packet
 * is prepended to the first keyframe chunk so SPS/PPS enter the stream in-band
 * (docs/protocol.md freezes the configuration packet as a separate frame).
 *
 * Pure functions only — this is the unit-tested core of decoding.
 */
import type { ParsedVideoFrame } from './connection.ts'

/** NAL unit types we care about. */
export const NAL_TYPE_SPS = 7
export const NAL_TYPE_PPS = 8
export const NAL_TYPE_IDR = 5

function startCodeLength(bytes: Uint8Array, offset: number): number {
  if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) return 0
  if (bytes[offset + 2] === 1) return 3
  if (bytes[offset + 2] === 0 && bytes[offset + 3] === 1) return 4
  return 0
}

/**
 * Split an Annex-B byte stream into NAL units, dropping the start codes.
 * @param data - one scrcpy packet payload.
 * @returns NAL units in stream order (empty when the payload has no start code).
 */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = []
  let index = 0
  let start = -1
  while (index < data.length - 2) {
    const length = startCodeLength(data, index)
    if (length !== 0) {
      if (start >= 0) units.push(data.subarray(start, index))
      index += length
      start = index
      continue
    }
    index += 1
  }
  if (start >= 0) units.push(data.subarray(start, data.length))
  return units.filter((unit) => unit.length > 0)
}

/** NAL unit type (lower 5 bits of the header byte). */
export function nalType(unit: Uint8Array): number {
  return (unit[0] ?? 0) & 0x1f
}

/**
 * Derive the WebCodecs codec string from the configuration packet's SPS:
 * `avc1.<profile><constraints><level>` (ISO/IEC 14496-15 §5.3.4).
 */
export function codecStringFromConfig(config: Uint8Array): string | undefined {
  const sps = splitAnnexB(config).find((unit) => nalType(unit) === NAL_TYPE_SPS)
  if (sps === undefined || sps.length < 4) return undefined
  const hex = (value: number): string => value.toString(16).padStart(2, '0').toUpperCase()
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`
}

/** VideoDecoder.configure() options for Annex-B H.264 (no `description`). */
export interface WebCodecsAvcConfig {
  codec: string
  avc: { format: 'annexb' }
  optimizeForLatency: true
}

/**
 * Build the decoder configuration for one scrcpy configuration packet.
 * @returns `undefined` when the packet carries no parseable SPS.
 */
export function webCodecsConfig(configPacket: Uint8Array): WebCodecsAvcConfig | undefined {
  const codec = codecStringFromConfig(configPacket)
  if (codec === undefined) return undefined
  return { codec, avc: { format: 'annexb' }, optimizeForLatency: true }
}

/** The subset of EncodedVideoChunkInit this client builds. */
export interface WebCodecsChunkInit {
  type: 'key' | 'delta'
  /** Microseconds, as required by WebCodecs. */
  timestamp: number
  data: Uint8Array
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length)
  out.set(first, 0)
  out.set(second, first.length)
  return out
}

/**
 * Build the encoded-chunk descriptor for one stream frame.
 *
 * In Annex-B mode the decoder needs SPS/PPS in-band, so the stored
 * configuration packet is prepended to the first keyframe chunk.
 * @param frame - keyframe or delta frame (configuration packets are not chunks).
 * @param configPrefix - configuration packet to prepend when this is the first
 *   keyframe after (re)configuration.
 * @returns the chunk descriptor, or `undefined` for non-video frame types.
 */
export function webCodecsChunk(
  frame: Pick<ParsedVideoFrame, 'type' | 'ptsMicros' | 'payload'>,
  configPrefix?: Uint8Array,
): WebCodecsChunkInit | undefined {
  if (frame.type !== 'keyframe' && frame.type !== 'delta') return undefined
  const type = frame.type === 'keyframe' ? 'key' : 'delta'
  const data =
    type === 'key' && configPrefix !== undefined && configPrefix.length > 0
      ? concat(configPrefix, frame.payload)
      : frame.payload
  return { type, timestamp: frame.ptsMicros, data }
}
