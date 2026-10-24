import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DeviceSizeCache,
  parseWmSize,
  peekDeviceSize,
  recordDeviceSize,
} from '../../src/stream/device-size.ts'
import type { AdbConnection } from '../../src/adb/types.ts'

test('parseWmSize：解析 Physical size（容忍空白/多行）', () => {
  assert.deepEqual(parseWmSize('Physical size: 1080x2400'), { width: 1080, height: 2400 })
  assert.deepEqual(
    parseWmSize('Physical size: 720x1280\nOverride size: 1080x1920\n'),
    { width: 720, height: 1280 },
    '优先 Physical size',
  )
  assert.deepEqual(parseWmSize('Physical size: 1080 x 2400'), { width: 1080, height: 2400 })
})

test('parseWmSize：只有 Override size 时回退', () => {
  assert.deepEqual(parseWmSize('Override size: 1440x3120'), { width: 1440, height: 3120 })
})

test('parseWmSize：缺失/非法/越界返回 undefined', () => {
  assert.equal(parseWmSize(''), undefined)
  assert.equal(parseWmSize('Display: mDisplayId=0'), undefined)
  assert.equal(parseWmSize('Physical size: 0x2400'), undefined)
  assert.equal(parseWmSize('Physical size: 999999x1'), undefined)
  assert.equal(parseWmSize('Physical size: abc'), undefined)
})

function fakeAdb(endpoint = { host: '127.0.0.1', port: 5555 }): {
  adb: AdbConnection
  calls: string[]
  state: { fail: boolean }
} {
  const calls: string[] = []
  const state = { fail: false }
  const adb = {
    endpoint,
    async shell(command: string) {
      calls.push(command)
      if (state.fail) throw new Error('adb error')
      return 'Physical size: 1080x2400\n'
    },
  } as unknown as AdbConnection
  return { adb, calls, state }
}

test('DeviceSizeCache：同 endpoint 只查一次并缓存', async () => {
  const { adb, calls } = fakeAdb()
  const cache = new DeviceSizeCache()
  assert.deepEqual(await cache.get(adb), { width: 1080, height: 2400 })
  assert.deepEqual(await cache.get(adb), { width: 1080, height: 2400 })
  assert.equal(calls.length, 1)
  assert.deepEqual(peekDeviceSize(), { width: 1080, height: 2400 })
})

test('DeviceSizeCache：shell 失败缓存 undefined，不抛错且不重复查询', async () => {
  const { adb, calls, state } = fakeAdb()
  state.fail = true
  const cache = new DeviceSizeCache()
  assert.equal(await cache.get(adb), undefined)
  assert.equal(await cache.get(adb), undefined)
  assert.equal(calls.length, 1)
})

test('recordDeviceSize / clear 维护进程级快照', () => {
  recordDeviceSize({ width: 720, height: 1600 })
  assert.deepEqual(peekDeviceSize(), { width: 720, height: 1600 })
  const cache = new DeviceSizeCache()
  cache.clear()
  assert.equal(peekDeviceSize(), undefined)
})
