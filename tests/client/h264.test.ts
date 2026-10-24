import test from 'node:test'
import assert from 'node:assert/strict'

import {
  codecStringFromConfig,
  nalType,
  splitAnnexB,
  webCodecsChunk,
  webCodecsConfig,
} from '../../src/client/h264.ts'
import { i420ToRgba } from '../../src/client/yuv.ts'

/** Annex-B byte stream: first unit gets a 4-byte start code, the rest get 3. */
function annexB(units: number[][]): Uint8Array {
  const parts: number[] = []
  for (const [index, unit] of units.entries()) {
    parts.push(...(index === 0 ? [0, 0, 0, 1] : [0, 0, 1]), ...unit)
  }
  return Uint8Array.from(parts)
}

const spsBody = [0x42, 0xe0, 0x1e, 0x9a, 0x66, 0x0a, 0x0f, 0xff]
const ppsBody = [0xce, 0x3c, 0x80]
const sps = [0x67, ...spsBody] // NAL header: type 7 (SPS)
const pps = [0x68, ...ppsBody] // NAL header: type 8 (PPS)
const idr = [0x65, 0x88, 0x84, 0x00] // NAL header: type 5 (IDR)

test('splitAnnexB separates NAL units and strips both start-code widths', () => {
  const units = splitAnnexB(annexB([sps, pps, idr]))
  assert.equal(units.length, 3)
  assert.deepEqual([...units[0]!], sps)
  assert.deepEqual([...units[1]!], pps)
  assert.deepEqual([...units[2]!], idr)
  assert.equal(nalType(units[0]!), 7)
  assert.equal(nalType(units[1]!), 8)
  assert.equal(nalType(units[2]!), 5)
})

test('splitAnnexB returns nothing for a packet without start codes', () => {
  assert.deepEqual(splitAnnexB(Uint8Array.from([1, 2, 3, 4])), [])
})

test('codecStringFromConfig reads profile/constraints/level from the SPS', () => {
  assert.equal(codecStringFromConfig(annexB([sps, pps])), 'avc1.42E01E')
  assert.equal(codecStringFromConfig(annexB([pps])), undefined)
})

test('webCodecsConfig asks for Annex-B and never sets a description', () => {
  const options = webCodecsConfig(annexB([sps, pps]))
  assert.ok(options)
  assert.deepEqual(options, {
    codec: 'avc1.42E01E',
    avc: { format: 'annexb' },
    optimizeForLatency: true,
  })
  assert.equal('description' in options, false, 'description would force AVCC framing')
  assert.equal(webCodecsConfig(annexB([pps])), undefined)
})

test('webCodecsChunk prepends the configuration packet to the first keyframe', () => {
  const config = annexB([sps, pps])
  const keyPayload = annexB([idr])
  const frame = { type: 'keyframe' as const, ptsMicros: 1_000_000, payload: keyPayload }
  const chunk = webCodecsChunk(frame, config)
  assert.ok(chunk)
  assert.equal(chunk.type, 'key')
  assert.equal(chunk.timestamp, 1_000_000)
  assert.equal(chunk.data.length, config.length + keyPayload.length)
  assert.deepEqual([...chunk.data.subarray(0, config.length)], [...config])
  assert.deepEqual([...chunk.data.subarray(config.length)], [...keyPayload])
})

test('webCodecsChunk leaves delta frames untouched and carries the pts timestamp', () => {
  const deltaPayload = annexB([[0x41, 0x9a, 0x00]])
  const chunk = webCodecsChunk({ type: 'delta', ptsMicros: 500_000, payload: deltaPayload }, Uint8Array.from([9]))
  assert.ok(chunk)
  assert.equal(chunk.type, 'delta')
  assert.equal(chunk.timestamp, 500_000)
  assert.deepEqual([...chunk.data], [...deltaPayload], 'no configuration prefix on delta frames')
})

test('webCodecsChunk ignores non-video frame types', () => {
  const payload = annexB([[0x67, 0x00]])
  for (const type of ['configuration', 'audio', 'control'] as const) {
    assert.equal(webCodecsChunk({ type, ptsMicros: 0, payload }), undefined)
  }
})

test('i420ToRgba converts black and white correctly', () => {
  // 2x2 black (Y=16, chroma neutral 128).
  const black = Uint8Array.from([16, 16, 16, 16, 128, 128])
  assert.deepEqual([...i420ToRgba(black, 2, 2)!], [
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
  ])
  const white = i420ToRgba(Uint8Array.from([235, 128, 128]), 1, 1)!
  assert.deepEqual([...white], [255, 255, 255, 255])
})

test('i420ToRgba rejects truncated buffers and reuses the provided target', () => {
  assert.equal(i420ToRgba(new Uint8Array(3), 2, 2), undefined)
  assert.equal(i420ToRgba(new Uint8Array(0), 0, 0), undefined)
  const target = new Uint8Array(4)
  const result = i420ToRgba(Uint8Array.from([235, 128, 128]), 1, 1, target)
  assert.equal(result, target)
})
