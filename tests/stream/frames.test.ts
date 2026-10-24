import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decodeFrameHeader,
  encodeFrame,
  encodeFrameHeader,
  encodePacket,
  FRAME_HEADER_SIZE,
  FRAME_MAGIC,
  FRAME_TYPE,
  MAX_PAYLOAD_BYTES,
  microsToTicks,
  PTS_MODULO,
  StreamClock,
} from '../../src/stream/frames.ts'

function payload(bytes: number[]): Uint8Array {
  return new Uint8Array(bytes)
}

test('帧头 magic 为 ASCII DPH1', () => {
  assert.deepEqual([...FRAME_MAGIC], [0x44, 0x50, 0x48, 0x31])
  const header = encodeFrameHeader(FRAME_TYPE.keyframe, 0)
  assert.equal(header.byteLength, FRAME_HEADER_SIZE)
  assert.deepEqual([...header.subarray(0, 4)], [0x44, 0x50, 0x48, 0x31])
})

test('meta 为大端 u32：高 4 bit 类型 + 低 28 bit pts', () => {
  const header = encodeFrameHeader(FRAME_TYPE.configuration, 0x0abcdef)
  assert.deepEqual([...header.subarray(4)], [0x00, 0x0a, 0xbc, 0xde])
  const key = encodeFrameHeader(FRAME_TYPE.keyframe, 1)
  assert.equal(key[4], 0x10)
  const delta = encodeFrameHeader(FRAME_TYPE.delta, 0x0fffffff)
  assert.deepEqual([...delta.subarray(4)], [0x2f, 0xff, 0xff, 0xff])
})

test('解析帧头可还原类型与 pts', () => {
  const header = encodeFrameHeader(FRAME_TYPE.keyframe, 123456)
  const decoded = decodeFrameHeader(header)
  assert.equal(decoded.frameType, FRAME_TYPE.keyframe)
  assert.equal(decoded.ptsTicks, 123456)
  assert.equal(decoded.payloadOffset, 8)
})

test('pts 在 2^28 处回绕', () => {
  assert.equal(PTS_MODULO, 268435456)
  assert.equal(microsToTicks(0n), 0)
  // 1s = 90000 ticks
  assert.equal(microsToTicks(1_000_000n), 90_000)
  // 回绕点前 1 个 tick
  const beforeWrap = (PTS_MODULO - 1) * (1_000_000 / 90_000)
  assert.equal(microsToTicks(BigInt(Math.round(beforeWrap))), PTS_MODULO - 1)
  // 回绕后归零
  assert.equal(microsToTicks(BigInt(Math.round(PTS_MODULO * (1_000_000 / 90_000)))), 0)
  // 超出一个周期后仍落在 28 bit 内
  const wrapped = microsToTicks(BigInt(PTS_MODULO) * 99n * 11_111n)
  assert.ok(wrapped >= 0 && wrapped < PTS_MODULO)
})

test('负的 pts 被规范化到 28 bit', () => {
  assert.equal(microsToTicks(-1_000_000n), PTS_MODULO - 90_000)
  const header = encodeFrameHeader(FRAME_TYPE.delta, -90000)
  assert.equal(decodeFrameHeader(header).ptsTicks, PTS_MODULO - 90_000)
})

test('payload 逐字节透传，长度 = 8 + payload', () => {
  const data = payload([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xff, 0x00])
  const frame = encodeFrame(FRAME_TYPE.delta, 7, data)
  assert.equal(frame.byteLength, 8 + data.byteLength)
  assert.deepEqual([...frame.subarray(8)], [...data])
})

test('超大包按上限拒绝，不静默截断', () => {
  const huge = new Uint8Array(MAX_PAYLOAD_BYTES + 1)
  assert.throws(() => encodeFrame(FRAME_TYPE.keyframe, 0, huge), /负载过大/)
  // 接近上限的包仍可正常编码（只验证长度，不实际分配 64MiB payload）
  const big = new Uint8Array(1024 * 1024)
  big[0] = 0x00
  big[big.length - 1] = 0x01
  const frame = encodeFrame(FRAME_TYPE.keyframe, 0, big)
  assert.equal(frame.byteLength, 8 + big.byteLength)
  assert.equal(frame[8], 0x00)
  assert.equal(frame[frame.length - 1], 0x01)
})

test('magic/长度非法时解析报错', () => {
  assert.throws(() => decodeFrameHeader(new Uint8Array(4)), /不足 8 字节/)
  const bad = new Uint8Array(8)
  bad.set([0x44, 0x50, 0x48, 0x32], 0)
  assert.throws(() => decodeFrameHeader(bad), /magic/)
})

test('configuration / keyframe / delta 映射与 pts 来源', () => {
  const config = encodePacket({ type: 'configuration', data: payload([1, 2]) }, 10)
  assert.equal(decodeFrameHeader(config).frameType, FRAME_TYPE.configuration)
  assert.equal(decodeFrameHeader(config).ptsTicks, 10)

  const key = encodePacket(
    { type: 'data', keyframe: true, pts: 1_000_000n, data: payload([3]) },
    99,
  )
  assert.equal(decodeFrameHeader(key).frameType, FRAME_TYPE.keyframe)
  assert.equal(decodeFrameHeader(key).ptsTicks, 90_000)

  const delta = encodePacket({ type: 'data', data: payload([4]) }, 42)
  assert.equal(decodeFrameHeader(delta).frameType, FRAME_TYPE.delta)
  assert.equal(decodeFrameHeader(delta).ptsTicks, 42)
})

test('StreamClock 单调递增且不回退', () => {
  const clock = new StreamClock()
  const a = clock.next(1_000)
  const b = clock.next(1_000)
  const c = clock.next(900)
  assert.ok(b > a)
  assert.ok(c > b)
  assert.ok(c < PTS_MODULO)
})
