import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { PhoneConfig } from '../../src/config/schema.ts'
import { prewarmPhoneService } from '../../src/phone/wiring.ts'

function makeConfig(options: { status: 'pending' | 'accepted' | 'declined'; prewarm?: boolean }): PhoneConfig {
  return {
    onboarding: {
      status: { get: () => options.status },
      choice: { get: () => 'emulator' },
    },
    lifecycle: { idleTimeoutMs: 300_000, pausedTimeoutMs: 1_800_000, prewarm: options.prewarm ?? false },
  } as unknown as PhoneConfig
}

interface Scheduled {
  callback?: () => void
  delayMs?: number
  disposed: boolean
}

function makeSchedule(): { schedule: (callback: () => void, delayMs: number) => () => void; state: Scheduled } {
  const state: Scheduled = { disposed: false }
  return {
    state,
    schedule: (callback, delayMs) => {
      state.callback = callback
      state.delayMs = delayMs
      return () => {
        state.disposed = true
      }
    },
  }
}

describe('预热（issue #67，默认关闭，可配置）', () => {
  test('accepted + prewarm=true → 延迟 ensureRunning', async () => {
    const scheduled = makeSchedule()
    let starts = 0
    const dispose = prewarmPhoneService(
      { ensureRunning: async () => { starts += 1 } } as never,
      makeConfig({ status: 'accepted', prewarm: true }),
      { delayMs: 50, schedule: scheduled.schedule },
    )
    assert.equal(scheduled.state.delayMs, 50)
    assert.equal(starts, 0)
    scheduled.state.callback?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(starts, 1)
    dispose()
    assert.equal(scheduled.state.disposed, true)
  })

  test('prewarm 默认 false → 不预热（只在面板打开/首次调用时启动）', () => {
    const scheduled = makeSchedule()
    prewarmPhoneService(
      { ensureRunning: async () => undefined } as never,
      makeConfig({ status: 'accepted' }),
      { schedule: scheduled.schedule },
    )
    assert.equal(scheduled.state.callback, undefined)
  })

  test('onboarding 未 accepted（pending/declined）→ 不预热', () => {
    for (const status of ['pending', 'declined'] as const) {
      const scheduled = makeSchedule()
      prewarmPhoneService(
        { ensureRunning: async () => undefined } as never,
        makeConfig({ status, prewarm: true }),
        { schedule: scheduled.schedule },
      )
      assert.equal(scheduled.state.callback, undefined, status)
    }
  })

  test('ensureRunning 失败被吞掉（预热不产生未处理拒绝）', async () => {
    const scheduled = makeSchedule()
    prewarmPhoneService(
      { ensureRunning: async () => { throw new Error('boot failed') } } as never,
      makeConfig({ status: 'accepted', prewarm: true }),
      { schedule: scheduled.schedule },
    )
    scheduled.state.callback?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    // 没有 unhandledRejection 即通过（node:test 会让该测试失败）
  })
})
