import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONFIG_NS,
  Config,
  RUNTIME_VALUES,
  WRITABLE_CONFIG_PATHS,
} from '../../src/config/schema.ts'

function isVolatile(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

test('Config：SPEC §6.1 全字段默认值', () => {
  const config = Config({})
  assert.equal(config.enabled, true)
  assert.equal(config.runtime, 'auto')

  assert.equal(config.attach.endpoint.get(), '')
  assert.equal(config.attach.userHint.get(), '')
  assert.equal(config.attach.resolved.get(), false)

  assert.equal(config.redroid.image, 'redroid/redroid:14-latest')
  assert.equal(config.redroid.memLimit, '2g')
  assert.equal(config.redroid.vcpuLimit, 2)

  assert.equal(config.emulator.avdName, '')
  assert.equal(config.emulator.resolution, '720x1280')

  assert.equal(config.stream.maxSize, 720)
  assert.equal(config.stream.maxFps, 15)
  assert.equal(config.stream.bitrate, 2000000)

  assert.equal(config.lifecycle.idleTimeoutMs, 300000)
  assert.equal(config.lifecycle.pausedTimeoutMs, 1800000)

  assert.equal(config.limits.maxInstances, 1)
  assert.equal(CONFIG_NS, 'dsh-phone')
})

test('Config：attach 三个叶子是 volatile，enabled/runtime/stream 不是', () => {
  const config = Config({})
  assert.ok(isVolatile(config.attach.endpoint))
  assert.ok(isVolatile(config.attach.userHint))
  assert.ok(isVolatile(config.attach.resolved))
  assert.equal(isVolatile(config.enabled), false)
  assert.equal(isVolatile(config.runtime), false)
  assert.equal(isVolatile(config.stream), false)
  assert.equal(isVolatile(config.lifecycle), false)
})

test('Config：WRITABLE_CONFIG_PATHS 与 volatile 叶子一致（R1 白名单）', () => {
  assert.deepEqual(
    WRITABLE_CONFIG_PATHS.map((path) => path.join('.')).sort(),
    [
      'attach.endpoint',
      'attach.resolved',
      'attach.userHint',
      'onboarding.choice',
      'onboarding.status',
    ],
  )
})

test('Config：onboarding 默认 pending / choice 空，且两个叶子是 volatile（issue #30）', () => {
  const config = Config({})
  assert.equal(config.onboarding.status.get(), 'pending')
  assert.equal(config.onboarding.choice.get(), '')
  assert.ok(isVolatile(config.onboarding.status))
  assert.ok(isVolatile(config.onboarding.choice))

  const accepted = Config({ onboarding: { status: 'accepted', choice: 'emulator' } })
  assert.equal(accepted.onboarding.status.get(), 'accepted')
  assert.equal(accepted.onboarding.choice.get(), 'emulator')
  assert.throws(() => Config({ onboarding: { status: 'yes' as never } }), /onboarding/)
  assert.throws(() => Config({ onboarding: { choice: 'waydroid' as never } }), /onboarding/)
})

test('Config：旧配置无 onboarding 段 → 默认 pending（升级兼容）', () => {
  const legacy = Config({
    enabled: true,
    runtime: 'attach',
    attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2000000 },
  })
  assert.equal(legacy.onboarding.status.get(), 'pending')
  assert.equal(legacy.onboarding.choice.get(), '')
})

test('Config：runtime 枚举严格（SPEC §6.1）', () => {
  assert.deepEqual([...RUNTIME_VALUES], ['auto', 'redroid', 'emulator', 'attach'])
  for (const runtime of RUNTIME_VALUES) {
    assert.equal(Config({ runtime }).runtime, runtime)
  }
  assert.throws(() => Config({ runtime: 'waydroid' as never }), /runtime/)
})

test('Config：显式覆盖 volatile 值后读取一致', () => {
  const config = Config({
    attach: { endpoint: '127.0.0.1:5555', userHint: '模拟器在 D:\\Android\\Sdk', resolved: true },
  })
  assert.equal(config.attach.endpoint.get(), '127.0.0.1:5555')
  assert.equal(config.attach.userHint.get(), '模拟器在 D:\\Android\\Sdk')
  assert.equal(config.attach.resolved.get(), true)
})