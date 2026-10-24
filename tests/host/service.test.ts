import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  AdbConnectionLike,
  CreateLifecycle,
  DeviceOps,
  LifecycleHooksLike,
  LifecycleLike,
  LifecycleStatusLike,
  PhoneServiceDeps,
  RuntimeHandle,
  ServiceConfig,
  StreamSession,
  StreamSessionOptions,
} from '../../src/phone/service.ts'
import { PhoneService } from '../../src/phone/service.ts'

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    runtime: 'attach',
    attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
    lifecycle: { idleTimeoutMs: 300_000, pausedTimeoutMs: 1_800_000 },
    ...overrides,
  }
}

interface FakeLifecycle extends LifecycleLike {
  hooks: LifecycleHooksLike
  ensureCalls: number
  touchCalls: number
  boot(): Promise<void>
  fail(error: Error): void
  emit(state: LifecycleStatusLike['state'], bootMs?: number): void
}

function makeLifecycle(initial: LifecycleStatusLike['state'] = 'stopped', manualBoot = false): FakeLifecycle {
  let status: LifecycleStatusLike = { state: initial, since: 0 }
  const listeners = new Set<(status: LifecycleStatusLike) => void>()
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined
  let booted = false
  const lifecycle: FakeLifecycle = {
    hooks: {
      start: async () => {},
      pause: async () => {},
      resume: async () => {},
      stop: async () => {},
    },
    ensureCalls: 0,
    touchCalls: 0,
    get state() {
      return status.state
    },
    get status() {
      return status
    },
    async ensureRunning() {
      lifecycle.ensureCalls += 1
      if (booted || status.state === 'running') {
        booted = true
        status = { state: 'running', since: 1, bootMs: 42 }
        return
      }
      status = { state: 'booting', since: 0 }
      if (!manualBoot) {
        await lifecycle.hooks.start()
        booted = true
        status = { state: 'running', since: 1, bootMs: 42 }
        for (const listener of listeners) listener(status)
        return
      }
      await new Promise<void>((resolve, reject) => {
        pending = { resolve, reject }
      })
    },
    async boot() {
      await lifecycle.hooks.start()
      booted = true
      status = { state: 'running', since: 1, bootMs: 42 }
      pending?.resolve()
      pending = undefined
      for (const listener of listeners) listener(status)
    },
    fail(error) {
      status = { state: 'stopped', since: 0, lastError: error.message }
      pending?.reject(error)
      pending = undefined
    },
    touch() {
      lifecycle.touchCalls += 1
    },
    notifyDisconnected(reason) {
      status = { state: 'stopped', since: 0, lastError: reason }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async dispose() {},
    emit(next, bootMs) {
      status = { state: next, since: 2, bootMs }
      for (const listener of listeners) listener(status)
    },
  }
  return lifecycle
}

interface Harness {
  service: PhoneService
  lifecycle: FakeLifecycle
  calls: string[]
  devices: DeviceOps[]
  devicesCreated: number
  streams: StreamSessionOptions[]
  sessions: FakeSession[]
  disconnected: number
  adapter: {
    pauseCalls: number
    resumeCalls: number
    stopCalls: number
    status: { kind: 'attach'; running: boolean; paused: boolean; endpoint: { host: string; port: number } }
  }
  closeCount: number
  schedule: { callback?: () => void; ms?: number }[]
}

interface FakeSession extends StreamSession {
  closeCalls: number
  text: string[]
  touches: string[]
}

function makeService(
  overrides: Partial<PhoneServiceDeps> = {},
  config = makeConfig(),
  manualBoot = false,
): Harness {
  const calls: string[] = []
  const lifecycle = makeLifecycle('stopped', manualBoot)
  const devices: DeviceOps[] = []
  const streams: StreamSessionOptions[] = []
  const sessions: FakeSession[] = []
  const schedule: { callback?: () => void; ms?: number }[] = []
  const harness: Harness = {
    service: undefined as unknown as PhoneService,
    lifecycle,
    calls,
    devices,
    devicesCreated: 0,
    streams,
    sessions,
    disconnected: 0,
    closeCount: 0,
    schedule,
    adapter: {
      pauseCalls: 0,
      resumeCalls: 0,
      stopCalls: 0,
      status: { kind: 'attach', running: true, paused: false, endpoint: { host: '127.0.0.1', port: 5555 } },
    },
  }

  const device: DeviceOps = {
    screenshot: async () => {
      calls.push('screenshot')
      return new Uint8Array([1, 2, 3])
    },
    tap: async (x, y) => {
      calls.push('tap:' + x + ',' + y)
    },
    swipe: async () => {},
    key: async (name) => {
      calls.push('key:' + name)
    },
    appLaunch: async () => {},
    dumpUi: async () => '<hierarchy/>',
    shell: async (command) => {
      calls.push('shell:' + command)
      return 'Pixel 7'
    },
  }

  const dependencies: PhoneServiceDeps = {
    config: () => config,
    resolveRuntime: async (): Promise<RuntimeHandle> => ({
      adapter: {
        kind: 'attach',
        probe: async () => ({ ok: true }),
        ensureRunning: async () => ({ host: '127.0.0.1', port: 5555 }),
        pause: async () => {
          harness.adapter.pauseCalls += 1
        },
        resume: async () => {
          harness.adapter.resumeCalls += 1
        },
        stop: async () => {
          harness.adapter.stopCalls += 1
        },
        status: async () => harness.adapter.status,
      },
      detection: { kind: 'attach', platform: 'linux' },
    }),
    platform: async () => 'linux',
    connect: async (): Promise<AdbConnectionLike> => ({
      raw: { fake: 'adb' },
      disconnected: new Promise<void>(() => {}),
      close: async () => {
        harness.disconnected += 1
      },
    }),
    disconnect: async () => {
      harness.disconnected += 1
    },
    createDevice: (): DeviceOps => {
      harness.devicesCreated += 1
      devices.push(device)
      return device
    },
    startStream: async (options) => {
      streams.push(options)
      let closeCalls = 0
      const session: FakeSession = {
        get closeCalls() {
          return closeCalls
        },
        text: [],
        touches: [],
        async injectText(text) {
          this.text.push(text)
        },
        async injectTouch(action, x, y) {
          this.touches.push(action + ':' + x + ',' + y)
        },
        async injectKey() {},
        async close() {
          closeCalls += 1
          harness.closeCount += 1
        },
      }
      sessions.push(session)
      return session
    },
    createLifecycle: ((hooks: LifecycleHooksLike): LifecycleLike => {
      lifecycle.hooks = hooks
      return lifecycle
    }) as CreateLifecycle,
    schedule: (callback, delayMs) => {
      schedule.push({ callback, ms: delayMs })
      return () => {}
    },
    ...overrides,
  }
  harness.service = new PhoneService(dependencies)
  return harness
}

test('ensureRunning 单飞：并发调用只触发一次 lifecycle.ensureRunning', async () => {
  const harness = makeService({}, makeConfig(), true)
  const first = harness.service.ensureRunning()
  const second = harness.service.ensureRunning()
  assert.equal(harness.lifecycle.ensureCalls, 1)
  await harness.lifecycle.boot()
  await Promise.all([first, second])
  assert.equal(harness.lifecycle.ensureCalls, 1)
  assert.equal(harness.devicesCreated, 1)
})

test('ensureInteractive：已在 booting 时立即返回中间态（含 bootMs，不等待）', async () => {
  const harness = makeService()
  harness.lifecycle.emit('booting', 4200)
  const readiness = await harness.service.ensureInteractive()
  assert.deepEqual(readiness, { state: 'booting', bootMs: 4200 })
  assert.equal(harness.lifecycle.ensureCalls, 0)
})

test('ensureInteractive：stopped 时懒启动并阻塞至 running', async () => {
  const harness = makeService()
  assert.deepEqual(await harness.service.ensureInteractive(), { state: 'running' })
  assert.equal(harness.devicesCreated, 1)
})

test('screenshot 串行：同一时刻只执行一次 screencap', async () => {
  const harness = makeService()
  await harness.service.ensureRunning()
  const resolvers: (() => void)[] = []
  let active = 0
  let maxActive = 0
  const originalDevice = harness.devices[0]!
  originalDevice.screenshot = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise<void>((resolve) => resolvers.push(resolve))
    active -= 1
    return new Uint8Array([9])
  }

  const first = harness.service.screenshot()
  const second = harness.service.screenshot()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(resolvers.length, 1)
  resolvers[0]!()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(resolvers.length, 2)
  resolvers[1]!()
  await second
  assert.equal(maxActive, 1)
})

test('inputText：无 viewer 时开 control-only 会话，走 INJECT_TEXT 而非 shell', async () => {
  const harness = makeService()
  await harness.service.inputText('你好，世界')
  assert.equal(harness.streams.length, 1)
  assert.equal(harness.streams[0]!.video, false)
  assert.deepEqual(harness.sessions[0]!.text, ['你好，世界'])
  assert.equal(harness.calls.some((call) => call.startsWith('shell:input')), false)
})

test('startStream：开视频会话并引用计数，release 后按宽限期关流', async () => {
  const harness = makeService()
  const sink = { video: () => {}, error: () => {} }
  const release = await harness.service.startStream(sink)
  assert.equal(harness.streams.length, 1)
  assert.equal(harness.streams[0]!.video, true)
  assert.equal(harness.sessions.length, 1)

  await release()
  assert.equal(harness.sessions[0]!.closeCalls, 0)
  assert.equal(harness.schedule.length, 1)
  assert.equal(harness.schedule[0]!.ms, 5000)
  harness.schedule[0]!.callback!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.sessions[0]!.closeCalls, 1)
})

test('touch：复用活动视频会话的控制通道', async () => {
  const harness = makeService()
  const sink = { video: () => {}, error: () => {} }
  await harness.service.startStream(sink)
  await harness.service.touch('down', 10, 20)
  assert.deepEqual(harness.sessions[0]!.touches, ['down:10,20'])
})

test('verifyEndpoint：R5 连通验证（connect + getprop），不落盘；失败返回 ok:false', async () => {
  const harness = makeService()
  const ok = await harness.service.verifyEndpoint('127.0.0.1:5555')
  assert.equal(ok.ok, true)
  assert.equal(ok.banner, 'Pixel 7')
  assert.ok(harness.calls.includes('shell:getprop ro.product.model'))
  assert.equal(harness.disconnected, 1)

  const failing = makeService({
    connect: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  const failed = await failing.service.verifyEndpoint('127.0.0.1:5555')
  assert.equal(failed.ok, false)
  assert.match(failed.error ?? '', /ECONNREFUSED/)

  const invalid = await harness.service.verifyEndpoint('not-an-endpoint')
  assert.equal(invalid.ok, false)
})

test('status：反映 runtime kind / platform / endpoint / bootMs', async () => {
  const harness = makeService()
  const status = await harness.service.status()
  assert.equal(status.runtime, 'attach')
  assert.equal(status.platform, 'linux')
  assert.deepEqual(status.endpoint, { host: '127.0.0.1', port: 5555 })

  harness.lifecycle.emit('running', 123)
  const booted = await harness.service.status()
  assert.equal(booted.state, 'running')
  assert.equal(booted.bootMs, 123)
})

test('onStateChange：生命周期变更映射为 PhoneStatus 事件', async () => {
  const harness = makeService()
  const events: string[] = []
  const off = harness.service.onStateChange((status) => events.push(status.state))
  harness.lifecycle.emit('running')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['running'])
  off()
  harness.lifecycle.emit('paused')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['running'])
})

test('dispose：关流、断 ADB、释放生命周期（幂等）', async () => {
  const harness = makeService()
  await harness.service.startStream({ video: () => {}, error: () => {} })
  await harness.service.dispose()
  assert.equal(harness.closeCount, 1)
  assert.ok(harness.disconnected >= 1)
  await harness.service.dispose()
  assert.equal(harness.closeCount, 1)
})