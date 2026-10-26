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
import type { BootPhase, Endpoint, RuntimeAdapter } from '../../src/runtime/types.ts'
import { ManualClock } from '../fake-adb/runtime.ts'

const ENDPOINT: Endpoint = { host: '127.0.0.1', port: 5555 }
const DUMPSYS = 'TOTAL: 6.0% user + 2.0% kernel'
const MEMINFO = 'MemTotal: 1000 kB\nMemAvailable: 250 kB'

interface Control {
  release(): void
  readonly gate: Promise<void>
  shells: string[]
}

function makeHarness(options: {
  deferred?: boolean
  shell?: (command: string) => Promise<string>
  waitBootCompleted?: boolean
} = {}): { service: PhoneService; control: Control } {
  let releaseGate: (() => void) | undefined
  const gate = options.deferred
    ? new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    : Promise.resolve()
  const shells: string[] = []
  const control: Control = {
    gate,
    shells,
    release: () => releaseGate?.(),
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
      shells.push(command)
      if (options.shell) return options.shell(command)
      if (command === 'dumpsys cpuinfo') return DUMPSYS
      if (command === 'cat /proc/meminfo') return MEMINFO
      return '1'
    },
  }
  const adapter: RuntimeAdapter = {
    kind: 'attach',
    probe: async () => ({ ok: true }),
    ensureRunning: async (onProgress?: (message: string, phase?: BootPhase) => void) => {
      onProgress?.('启动 attach 校验…', 'launching')
      if (options.deferred) await gate
      onProgress?.('等待端口就绪…', 'waiting-adbd')
      onProgress?.('就绪', 'ready')
      return ENDPOINT
    },
    pause: async () => undefined,
    resume: async () => undefined,
    stop: async () => undefined,
    status: async () => ({ kind: 'attach', running: true, paused: false, owned: false, adopted: true, endpoint: ENDPOINT }),
    isAlive: async () => true,
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
    waitBootCompleted: options.waitBootCompleted === true,
    bootReadyTimeoutMs: 5_000,
  }
  return { service: new PhoneService(deps), control }
}

describe('booting phase（issue #56，向 /status 暴露进度阶段）', () => {
  test('booting 时 status.phase 跟随适配器进度；running 后不再带 phase', async () => {
    const { service, control } = makeHarness({ deferred: true })
    const running = service.ensureRunning()
    // 等适配器回调把 phase 置为 launching
    await new Promise<void>((resolve) => setImmediate(resolve))
    const booting = await service.status()
    assert.equal(booting.state, 'booting')
    assert.equal(booting.phase, 'launching')
    assert.equal(typeof booting.bootMs, 'number')

    control.release()
    await running
    // booting 期间适配器还会发 waiting-adbd，但最终状态是 running
    const status = await service.status()
    assert.equal(status.state, 'running')
    assert.equal(status.phase, undefined)
    await service.dispose()
  })
})

describe('attach cpuPct/memPct（issue #56，尽力而为）', () => {
  test('running 时用 dumpsys cpuinfo + /proc/meminfo 补齐，并缓存 5s', async () => {
    const { service, control } = makeHarness()
    await service.ensureRunning()
    const status = await service.status()
    assert.equal(status.cpuPct, 8)
    assert.equal(status.memPct, 75)
    assert.deepEqual(control.shells, ['dumpsys cpuinfo', 'cat /proc/meminfo'])
    // 第二次 status 命中缓存，不再发 shell
    const again = await service.status()
    assert.equal(again.cpuPct, 8)
    assert.equal(control.shells.length, 2)
    await service.dispose()
  })

  test('shell 失败时省略字段（不报错）', async () => {
    const { service } = makeHarness({
      shell: async () => {
        throw new Error('device busy')
      },
    })
    await service.ensureRunning()
    const status = await service.status()
    assert.equal(status.state, 'running')
    assert.equal(status.cpuPct, undefined)
    assert.equal(status.memPct, undefined)
    await service.dispose()
  })
})


describe('boot_completed + pm ready（issue #67，可选就绪判定）', () => {
  test('waitBootCompleted=true：getprop 变 1 且 pm 可用后才算 running', async () => {
    const shells: string[] = []
    let bootChecks = 0
    const { service } = makeHarness({
      waitBootCompleted: true,
      shell: async (command) => {
        shells.push(command)
        if (command === 'getprop sys.boot_completed') {
          bootChecks += 1
          return bootChecks >= 2 ? '1' : ''
        }
        if (command === 'getprop init.svc.bootanim') return 'stopped'
        if (command === 'pm path android') return 'package:/system/framework/framework-res.apk'
        return ''
      },
    })
    await service.ensureRunning()
    assert.ok(shells.filter((command) => command === 'getprop sys.boot_completed').length >= 2)
    assert.ok(shells.includes('getprop init.svc.bootanim'))
    assert.ok(shells.includes('pm path android'))
    const status = await service.status()
    assert.equal(status.state, 'running')
    await service.dispose()
  })

  test('waitBootCompleted=false（默认）：不额外轮询 shell', async () => {
    const { service, control } = makeHarness()
    await service.ensureRunning()
    assert.equal(control.shells.includes('getprop sys.boot_completed'), false)
    await service.dispose()
  })
})
