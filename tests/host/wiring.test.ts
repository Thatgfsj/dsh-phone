import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readOnboarding, readServiceConfig } from '../../src/phone/wiring.ts'
import type { PhoneConfig } from '../../src/config/schema.ts'

/** 构造最小 PhoneConfig 形状（只提供 readServiceConfig 读到的字段）。 */
function fakeConfig(options: {
  runtime?: string
  status?: string
  choice?: string
  attach?: { endpoint?: string; userHint?: string; resolved?: boolean }
}): PhoneConfig {
  const leaf = <T,>(value: T) => ({ get: () => value })
  return {
    runtime: options.runtime ?? 'auto',
    onboarding: {
      status: leaf(options.status ?? 'pending'),
      choice: leaf(options.choice ?? ''),
    },
    attach: {
      endpoint: leaf(options.attach?.endpoint ?? ''),
      userHint: leaf(options.attach?.userHint ?? ''),
      resolved: leaf(options.attach?.resolved ?? false),
    },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
    lifecycle: { idleTimeoutMs: 300_000, pausedTimeoutMs: 1_800_000 },
  } as unknown as PhoneConfig
}

test('readOnboarding / readServiceConfig：accepted+choice 等价显式 runtime', () => {
  const emulator = fakeConfig({ status: 'accepted', choice: 'emulator' })
  assert.deepEqual(readOnboarding(emulator), { status: 'accepted', choice: 'emulator' })
  assert.equal(readServiceConfig(emulator).runtime, 'emulator')

  const auto = fakeConfig({ status: 'accepted', choice: '' })
  assert.equal(readServiceConfig(auto).runtime, 'auto')

  const configured = fakeConfig({ status: 'accepted', choice: '', runtime: 'attach' })
  assert.equal(readServiceConfig(configured).runtime, 'attach')

  const pending = fakeConfig({ status: 'pending', choice: 'redroid' })
  assert.equal(readServiceConfig(pending).runtime, 'auto')
})
