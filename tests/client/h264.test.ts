import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAvcC, codecStringFromConfig, nalType, splitAnnexB } from '../../src/client/h264.ts'
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

test('buildAvcC wraps SPS/PPS in an AVCDecoderConfigurationRecord', () => {
  const record = buildAvcC(annexB([sps, pps]))
  assert.ok(record)
  assert.equal(record.length, 11 + sps.length + pps.length)
  assert.equal(record[0], 1, 'configurationVersion')
  assert.equal(record[1], 0x42, 'profile from SPS')
  assert.equal(record[2], 0xe0, 'constraint flags from SPS')
  assert.equal(record[3], 0x1e, 'level from SPS')
  assert.equal(record[4], 0xff, 'lengthSizeMinusOne = 3')
  assert.equal(record[5], 0xe1, 'one SPS')
  const spsLength = (record[6]! << 8) | record[7]!
  assert.equal(spsLength, sps.length)
  assert.deepEqual([...record.subarray(8, 8 + spsLength)], sps)
  const ppsOffset = 8 + spsLength
  assert.equal(record[ppsOffset], 1)
  assert.equal((record[ppsOffset + 1]! << 8) | record[ppsOffset + 2]!, pps.length)
  assert.deepEqual([...record.subarray(ppsOffset + 3)], pps)
})

test('buildAvcC refuses packets missing SPS or PPS', () => {
  assert.equal(buildAvcC(annexB([sps])), undefined)
  assert.equal(buildAvcC(annexB([pps])), undefined)
  assert.equal(buildAvcC(Uint8Array.from([0, 0, 1, 0x67])), undefined)
  assert.equal(buildAvcC(new Uint8Array()), undefined)
})

test('codecStringFromConfig reads profile/constraints/level from the SPS', () => {
  assert.equal(codecStringFromConfig(annexB([sps, pps])), 'avc1.42E01E')
  assert.equal(codecStringFromConfig(annexB([pps])), undefined)
})

test('i420ToRgba converts black and white correctly', () => {
  // 2x2 black (Y=16, chroma neutral 128).
  const black = Uint8Array.from([16, 16, 16, 16, 128, 128])
  assert.deepEqual([...i420ToRgba(black, 2, 2)!], [
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
  ])
  // 1x1 white (Y=235).
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
