import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { PhoneLifecycle } from '../../src/phone/state.ts'
import { PhoneService } from '../../src/phone/service.ts'
import type {
  AdbConnectionLike,
  DeviceOps,
  PhoneServiceDeps,
  ServiceConfig,
} from '../../src/phone/service.ts'
import type { BootPhase, Endpoint, RuntimeAdapter, RuntimeStatus } from '../../src/runtime/types.ts'
import { ManualClock } from '../fake-adb/runtime.ts'

const ENDPOINT: Endpoint = { host: '127.0.0.1', port: 5555 }

interface Control {
  owned: boolean
  alive: boolean
  stopCalls: number
  cancelCalls: number
  ensureCalls: number
  hangStart: boolean
  hangStop: boolean
  releaseStart?: () => void
  watchdogTick?: () => void
  shells: string[]
}

interface Harness {
  service: PhoneService
  control: Control
}

function makeHarness(
  overrides: { owned?: boolean; hangStart?: boolean; hangStop?: boolean; actionTimeoutMs?: number; disposeBudgetMs?: number } = {},
): Harness {
  const control: Control = {
    owned: overrides.owned ?? true,
    alive: true,
    stopCalls: 0,
    cancelCalls: 0,
    ensureCalls: 0,
    hangStart: overrides.hangStart === true,
    hangStop: overrides.hangStop === true,
    shells: [],
  }
  const connection: AdbConnectionLike = {
    raw: {},
    disconnected: new Promise<void>(() => undefined),
    close: async () => undefined,
  }
  const device: DeviceOps = {
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    tap: async () => undefined,
    swipe: async () => undefined,
    key: async () => undefined,
    appLaunch: async () => undefined,
    dumpUi: async () => '<hierarchy/>',
    shell: async (command) => {
      control.shells.push(command)
      return '1'
    },
  }
  const status = async (): Promise<RuntimeStatus> => ({
    kind: 'attach',
    running: control.alive,
    paused: false,
    owned: control.owned,
    adopted: !control.owned,
    endpoint: ENDPOINT,
  })
  const adapter: RuntimeAdapter = {
    kind: 'attach',
    probe: async () => ({ ok: true }),
    ensureRunning: async (onProgress?: (message: string, phase?: BootPhase) => void) => {
      control.ensureCalls += 1
      onProgress?.('booting', 'launching')
      if (control.hangStart) {
        await new Promise<void>((resolve) => {
          control.releaseStart = resolve
        })
      }
      return ENDPOINT
    },
    pause: async () => undefined,
    resume: async () => undefined,
    stop: async () => {
      control.stopCalls += 1
      if (control.hangStop) await new Promise<void>(() => undefined)
    },
    status,
    isAlive: async () => control.alive,
    cancelStart: async () => {
      control.cancelCalls += 1
      control.releaseStart?.()
    },
  }
  const config: ServiceConfig = {
    runtime: 'attach',
    attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
    lifecycle: { idleTimeoutMs: 1_200_000, pausedTimeoutMs: 1_800_000 },
  }
  const deps: PhoneServiceDeps = {
    config: () => config,
    resolveRuntime: async () => ({ adapter, detection: { kind: 'attach', platform: 'linux' } }),
    platform: async () => 'linux',
    connect: async () => connection,
    disconnect: async () => undefined,
    createDevice: () => device,
    startStream: async () => ({
      injectText: async () => undefined,
      injectTouch: async () => undefined,
      injectKey: async () => undefined,
      close: async () => undefined,
    }),
    createLifecycle: (hooks, timings) => new PhoneLifecycle(hooks, timings, new ManualClock()),
    sleep: async () => undefined,
    bootRetryDelays: () => [],
    setInterval: (callback) => {
      control.watchdogTick = callback
      return () => {
        control.watchdogTick = undefined
      }
    },
    actionTimeoutMs: overrides.actionTimeoutMs ?? 5_000,
    disposeBudgetMs: overrides.disposeBudgetMs ?? 5_000,
  }
  return { service: new PhoneService(deps), control }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('issue #83：看门狗（外部 kill 兜底）', () => {
  test('running 时外部 kill → 2s 内 stopped + lastError + 清理', async () => {
    const { service, control } = makeHarness()
    await service.ensureRunning()
    assert.equal((await service.status()).state, 'running')
    assert.ok(control.watchdogTick, 'running 时应启动看门狗')
    control.alive = false
    control.watchdogTick?.()
    await flush()
    const status = await service.status()
    assert.equal(status.state, 'stopped')
    assert.match(status.lastError ?? '', /外部关闭/)
    await service.dispose()
  })

  test('booting 中外部消失同样处理', async () => {
    const { service, control } = makeHarness({ hangStart: true })
    const booting = service.ensureRunning()
    await flush()
    assert.equal((await service.status()).state, 'booting')
    control.alive = false
    control.watchdogTick?.()
    await flush()
    assert.equal((await service.status()).state, 'stopped')
    control.releaseStart?.()
    await booting.catch(() => undefined)
    await service.dispose()
  })
})

describe('issue #83：stop 语义（owned vs adopted）', () => {
  test('owned → 调用 adapter.stop（保存快照等退出）', async () => {
    const { service, control } = makeHarness({ owned: true })
    await service.ensureRunning()
    const status = await service.stop()
    assert.equal(control.stopCalls, 1)
    assert.equal(status.state, 'stopped')
    assert.equal(status.owned, true)
    await service.dispose()
  })

  test('adopted → 只断开，不杀用户实例，lastError 提示', async () => {
    const { service, control } = makeHarness({ owned: false })
    await service.ensureRunning()
    const status = await service.stop()
    assert.equal(control.stopCalls, 0)
    assert.equal(status.state, 'stopped')
    assert.match(status.lastError ?? '', /实例由用户启动/)
    await service.dispose()
  })

  test('booting 中 stop → cancelStart 打断并快速 stopped', async () => {
    const { service, control } = makeHarness({ hangStart: true })
    const booting = service.ensureRunning()
    await flush()
    const startedAt = Date.now()
    const status = await service.stop()
    assert.ok(Date.now() - startedAt < 2_000)
    assert.equal(control.cancelCalls, 1)
    assert.equal(status.state, 'stopped')
    await booting.catch(() => undefined)
    await service.dispose()
  })
})

describe('issue #83：restart/并发/超时', () => {
  test('restart = stop → start，最终 running', async () => {
    const { service, control } = makeHarness()
    await service.ensureRunning()
    const before = control.ensureCalls
    const status = await service.restart()
    assert.equal(status.state, 'running')
    assert.equal(control.stopCalls, 1)
    assert.ok(control.ensureCalls > before)
    await service.dispose()
  })

  test('并发 stop 合并为一次 adapter.stop', async () => {
    const { service, control } = makeHarness()
    await service.ensureRunning()
    const [a, b] = await Promise.all([service.stop(), service.stop()])
    assert.equal(control.stopCalls, 1)
    assert.equal(a.state, 'stopped')
    assert.equal(b.state, 'stopped')
    await service.dispose()
  })

  test('动作超时 → 抛 RuntimeError（带 timeout 语义）', async () => {
    const { service } = makeHarness({ hangStop: true, actionTimeoutMs: 100 })
    await service.ensureRunning()
    await assert.rejects(service.stop(), /超时/)
    await service.dispose()
  })
})

describe('issue #83：dispose 硬预算', () => {
  test('boot 挂起时 dispose ≤ 预算返回，并 cancelStart 停止半启动', async () => {
    const { service, control } = makeHarness({ hangStart: true, disposeBudgetMs: 200 })
    const booting = service.ensureRunning()
    await flush()
    const startedAt = Date.now()
    await service.dispose()
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 1_500, 'dispose 应远小于 boot 120s，实际 ' + elapsed + 'ms')
    assert.ok(control.cancelCalls >= 1, 'dispose 应取消半启动实例')
    control.releaseStart?.()
    await booting.catch(() => undefined)
  })

  test('dispose：owned 尝试 stop，adopted 只断开', async () => {
    const owned = makeHarness({ owned: true })
    await owned.service.ensureRunning()
    await owned.service.dispose()
    assert.equal(owned.control.stopCalls, 1)

    const adopted = makeHarness({ owned: false })
    await adopted.service.ensureRunning()
    await adopted.service.dispose()
    assert.equal(adopted.control.stopCalls, 0)
  })
})
