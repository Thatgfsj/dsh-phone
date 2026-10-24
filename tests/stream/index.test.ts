import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createStreamUpgradeHandler,
  createStreamUpgradeRoute,
  DEFAULT_STREAM_OPTIONS,
  normalizeStreamOptions,
  startControlOnly,
  startStream,
  STREAM_PATH,
  StreamSession,
} from '../../src/stream/index.ts'
import type { PhoneStreamService } from '../../src/stream/index.ts'

function fakeService(): PhoneStreamService {
  return {
    async ensureRunning() {},
    async startStream() {
      return async () => {}
    },
    async touch() {},
    async inputText() {},
    async key() {},
  }
}

test('稳定入口导出 host 需要的 API', () => {
  assert.equal(typeof startStream, 'function')
  assert.equal(typeof startControlOnly, 'function')
  assert.equal(typeof createStreamUpgradeHandler, 'function')
  assert.equal(typeof createStreamUpgradeRoute, 'function')
  assert.equal(typeof StreamSession, 'function')
  assert.equal(STREAM_PATH, '/dsh-phone/stream')
  assert.deepEqual(DEFAULT_STREAM_OPTIONS, { maxSize: 720, maxFps: 15, bitrate: 2_000_000 })
})

test('createStreamUpgradeRoute 返回 { path, handler }（host 可直接 registerUpgrade）', () => {
  const route = createStreamUpgradeRoute({ service: fakeService() })
  assert.equal(route.path, '/dsh-phone/stream')
  assert.equal(typeof route.handler, 'function')
})

test('normalizeStreamOptions 非法值回落到默认并夹取范围', () => {
  assert.deepEqual(normalizeStreamOptions(), DEFAULT_STREAM_OPTIONS)
  assert.deepEqual(normalizeStreamOptions({ maxSize: 0, maxFps: 999, bitrate: 1 }), {
    maxSize: 1,
    maxFps: 120,
    bitrate: 100_000,
  })
  assert.equal(normalizeStreamOptions({ maxSize: 1080 }).maxSize, 1080)
})
