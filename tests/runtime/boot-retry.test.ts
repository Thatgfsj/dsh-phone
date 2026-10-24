import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AdbError, AdbTimeoutError } from '../../src/adb/types.ts'
import {
  BOOT_RETRY_BASE_MS,
  BOOT_RETRY_MAX_DELAY_MS,
  DEFAULT_BOOT_TIMEOUT_MS,
  bootRetryDelays,
  bootRetryExhaustedMessage,
  isRetryableBootError,
} from '../../src/phone/boot-retry.ts'
import { PhoneLifecycle } from '../../src/phone/state.ts'
import { PhoneService } from '../../src/phone/service.ts'
import type {
  AdbConnectionLike,
  DeviceOps,
  PhoneServiceDeps,
  ServiceConfig,
} from '../../src/phone/service.ts'
import type { Endpoint, RuntimeAdapter } from '../../src/runtime/types.ts'
import { ManualClock } from '../fake-adb/runtime.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('bootRetryDelays：500ms→1s→2s→4s→8s 封顶', () => {
  test('序列前 5 项与封顶', () => {
    const delays = bootRetryDelays(DEFAULT_BOOT_TIMEOUT_MS)
    assert.deepEqual(delays.slice(0, 5), [500, 1000, 2000, 4000, 8000])
    assert.equal(delays[0], BOOT_RETRY_BASE_MS)
    assert.ok(delays.slice(5).every((delay) => delay === BOOT_RETRY_MAX_DELAY_MS))
  })

  test('累计延迟不超过窗口上限（尝试次数 = 延迟数 + 1）', () => {
    for (const budget of [1_000, 5_000, 60_000, DEFAULT_BOOT_TIMEOUT_MS]) {
      const delays = bootRetryDelays(budget)
      const total = delays.reduce((sum, delay) => sum + delay, 0)
      assert.ok(total <= budget, 'total ' + total + ' > ' + budget)
    }
    assert.deepEqual(bootRetryDelays(0), [])
    assert.deepEqual(bootRetryDelays(-1), [])
  })

  test('120s 窗口内有足够多的尝试（>= 10 次）', () => {
    assert.ok(bootRetryDelays(DEFAULT_BOOT_TIMEOUT_MS).length >= 10)
  })
})

describe('isRetryableBootError：只重试暂时性错误', () => {
  test('ADB 层错误一律重试（含握手超时/连接失败/设备未就绪）', () => {
    assert.equal(isRetryableBootError(new AdbTimeoutError('握手超时', 8000)), true)
    assert.equal(isRetryableBootError(new AdbError('连接被拒', 'connect')), true)
    assert.equal(isRetryableBootError(new AdbError('设备未就绪', 'device-not-ready')), true)
  })

  test('带 retryable:true 的普通错误重试；普通 Error 不重试', () => {
    assert.equal(isRetryableBootError(Object.assign(new Error('x'), { retryable: true })), true)
    assert.equal(isRetryableBootError(new Error('参数错误')), false)
    assert.equal(isRetryableBootError(Object.assign(new Error('x'), { code: 'attach-unresolved' })), false)
  })

  test('耗尽文案包含尝试次数、窗口与最后原因', () => {
    const text = bootRetryExhaustedMessage(19, 100_000, new Error('ADB 认证握手超时'))
    assert.match(text, /已尝试 19 次/)
    assert.match(text, /约 100s/)
    assert.match(text, /ADB 认证握手超时/)
    assert.match(text, /稍后重试/)
  })
})

interface HarnessControl {
  connectFailures: number
  failure: () => Error
}

interface Harness {
  service: PhoneService
  control: HarnessControl
  state: { connectCalls: number; sleeps: number[] }
}

function makeHarness(options: {
  connectFailures?: number
  failure?: () => Error
  delays?: number[]
} = {}): Harness {
  const endpoint: Endpoint = { host: '127.0.0.1', port: 5555 }
  const state = { connectCalls: 0, sleeps: [] as number[] }
  const control: HarnessControl = {
    connectFailures: options.connectFailures ?? 0,
    failure: options.failure ?? (() => new AdbTimeoutError('与 127.0.0.1:5555 的 ADB 认证握手超时（8000ms）', 8000)),
  }
  const connection: AdbConnectionLike = {
    raw: {},
    disconnected: new Promise<void>(() => undefined),
    close: async () => undefined,
  }
  const device: DeviceOps = {
    screenshot: async () => PNG,
    tap: async () => undefined,
    swipe: async () => undefined,
    key: async () => undefined,
    appLaunch: async () => undefined,
    dumpUi: async () => '<hierarchy/>',
    shell: async () => '1',
  }
  const adapter: RuntimeAdapter = {
    kind: 'attach',
    probe: async () => ({ ok: true }),
    ensureRunning: async () => endpoint,
    pause: async () => undefined,
    resume: async () => undefined,
    stop: async () => undefined,
    status: async () => ({ kind: 'attach', running: true, paused: false, endpoint }),
  }
  const config: ServiceConfig = {
    runtime: 'attach',
    attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
    lifecycle: { idleTimeoutMs: 300_000, pausedTimeoutMs: 1_800_000 },
  }
  const deps: PhoneServiceDeps = {
    config: () => config,
    resolveRuntime: async () => ({ adapter, detection: { kind: 'attach', platform: 'linux' } }),
    platform: async () => 'linux',
    connect: async () => {
      state.connectCalls += 1
      if (state.connectCalls <= control.connectFailures) throw control.failure()
      return connection
    },
    disconnect: async () => undefined,
    createDevice: () => device,
    startStream: async () => ({
      injectText: async () => undefined,
      injectTouch: async () => undefined,
      injectKey: async () => undefined,
      close: async () => undefined,
    }),
    createLifecycle: (hooks, timings) => new PhoneLifecycle(hooks, timings, new ManualClock()),
    now: () => Date.now(),
    sleep: async (delayMs) => {
      state.sleeps.push(delayMs)
    },
    bootRetryDelays: () => options.delays ?? [10, 20],
  }
  return { service: new PhoneService(deps), control, state }
}

describe('PhoneService：冷启动窗口内 ADB 握手重试（issue #44）', () => {
  test('握手前 2 次超时后成功：按 10ms/20ms 退避，最终 running', async () => {
    const harness = makeHarness({ connectFailures: 2 })
    await harness.service.ensureRunning()
    assert.equal(harness.state.connectCalls, 3)
    assert.deepEqual(harness.state.sleeps, [10, 20])
    const status = await harness.service.status()
    assert.equal(status.state, 'running')
    assert.equal(status.lastError, undefined)
    await harness.service.dispose()
  })

  test('握手一直失败：重试耗尽才抛冷启动错误（connect 次数 = 延迟数 + 1）', async () => {
    const harness = makeHarness({ connectFailures: 99 })
    await assert.rejects(harness.service.ensureRunning(), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /冷启动窗口中 ADB 仍未就绪/)
      assert.match(error.message, /已尝试 3 次/)
      assert.match(error.message, /ADB 认证握手超时/)
      return true
    })
    assert.equal(harness.state.connectCalls, 3)
    assert.deepEqual(harness.state.sleeps, [10, 20])
    const status = await harness.service.status()
    assert.equal(status.state, 'stopped')
    assert.match(status.lastError ?? '', /冷启动窗口中 ADB 仍未就绪/)
    await harness.service.dispose()
  })

  test('非暂时性错误（普通 Error）不重试，立即失败', async () => {
    const harness = makeHarness({
      connectFailures: 99,
      failure: () => new Error('endpoint 配置非法'),
    })
    await assert.rejects(harness.service.ensureRunning(), /endpoint 配置非法/)
    assert.equal(harness.state.connectCalls, 1)
    assert.deepEqual(harness.state.sleeps, [])
    await harness.service.dispose()
  })

  test('失败后下一次成功：running 状态不再保留旧的 lastError', async () => {
    const harness = makeHarness({ connectFailures: 99, delays: [] })
    await assert.rejects(harness.service.ensureRunning(), /冷启动窗口中 ADB 仍未就绪/)
    const failed = await harness.service.status()
    assert.equal(failed.state, 'stopped')
    assert.match(failed.lastError ?? '', /握手超时|冷启动/)

    harness.control.connectFailures = 0
    await harness.service.ensureRunning()
    const status = await harness.service.status()
    assert.equal(status.state, 'running')
    assert.equal(status.lastError, undefined)
    await harness.service.dispose()
  })

  test('冷启动窗口内截图失败属于暂时性错误（device-not-ready 可重试）', async () => {
    const harness = makeHarness()
    await harness.service.ensureRunning()
    const error = new AdbError('E_DEVICE_NOT_READY: 截图输出为空', 'device-not-ready')
    assert.equal(error.retryable, true)
    assert.equal(isRetryableBootError(error), true)
    await harness.service.dispose()
  })
})
