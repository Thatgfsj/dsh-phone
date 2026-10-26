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
import type { RuntimeStatus } from '../../src/runtime/types.ts'

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
  halt(reason?: string): void
  stopNow(reason?: string): Promise<void>
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
        try {
          await lifecycle.hooks.start()
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          lifecycle.hooks.onError?.(failure, 'start')
          status = { state: 'stopped', since: 0, lastError: failure.message }
          for (const listener of listeners) listener(status)
          throw failure
        }
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
      booted = false
      status = { state: 'stopped', since: 0, lastError: reason }
    },
    halt(reason) {
      booted = false
      status = { state: 'stopped', since: 0, lastError: reason }
    },
    async stopNow(reason) {
      try { await lifecycle.hooks.stop() } catch { /* ignore */ }
      booted = false
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
    status: { kind: 'attach'; running: boolean; paused: boolean; owned: boolean; adopted: boolean; endpoint: { host: string; port: number } }
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
      status: { kind: 'attach', running: true, paused: false, owned: false, adopted: true, endpoint: { host: '127.0.0.1', port: 5555 } },
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
        isAlive: async () => harness.adapter.status.running,
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
  const closeTimer = harness.schedule.find((item) => item.ms === 5000)
  assert.ok(closeTimer, 'release 后必须安排 5s 宽限关流')
  closeTimer!.callback!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.sessions[0]!.closeCalls, 1)
})

test('touch：复用活动视频会话的控制通道', async () => {
  const harness = makeService()
  const sink = { video: () => {}, error: () => {} }
  await harness.service.startStream(sink)
  await harness.service.touchScreen('down', 10, 20)
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
/* ------------------------- 运行时探测缓存（issue #36） ------------------------- */

function makeHandle(
  kind: 'attach' | 'emulator' | 'redroid',
  options: {
    ensureRunning?: () => Promise<{ host: string; port: number }>
    status?: () => Promise<RuntimeStatus>
  } = {},
): RuntimeHandle {
  const endpoint = { host: '127.0.0.1', port: 5555 }
  return {
    adapter: {
      kind,
      probe: async () => ({ ok: true }),
      ensureRunning: options.ensureRunning ?? (async () => endpoint),
      pause: async () => {},
      resume: async () => {},
      stop: async () => {},
      status:
        options.status ??
        (async () => ({ kind, running: true, paused: false, owned: false, adopted: true, endpoint })),
      isAlive: async () => true,
    },
    detection: { kind, platform: 'linux' },
  }
}

test('探测失败不永久缓存：30s 后重新探测成功（不重建 service、无需重载插件）', async () => {
  let now = 1_000_000
  let available = false
  let resolveCalls = 0
  const harness = makeService({
    now: () => now,
    resolveRuntime: async () => {
      resolveCalls += 1
      if (!available) {
        throw Object.assign(new Error('没有可用的 Android 运行时'), { code: 'unavailable' })
      }
      return makeHandle('attach')
    },
  })

  await assert.rejects(harness.service.ensureRunning(), /没有可用的 Android 运行时/)
  assert.equal(resolveCalls, 1)

  // 环境变可用，但仍在 30s 防抖窗口内 → 不重复探测
  available = true
  await assert.rejects(harness.service.ensureRunning(), /没有可用的 Android 运行时/)
  assert.equal(resolveCalls, 1)

  // 超过 TTL → 下一次调用重新探测并成功
  now += 30_000
  await harness.service.ensureRunning()
  assert.equal(resolveCalls, 2)
  assert.equal(harness.lifecycle.state, 'running')
})

test('探测失败防抖：TTL 内多次 status/工具调用不产生探测风暴', async () => {
  let now = 2_000_000
  let resolveCalls = 0
  const harness = makeService({
    now: () => now,
    resolveRuntime: async () => {
      resolveCalls += 1
      throw Object.assign(new Error('三路全不可用'), { code: 'unavailable' })
    },
  })
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(harness.service.status(), /三路全不可用/)
    now += 1_000
  }
  assert.equal(resolveCalls, 1)
})

test('status 在探测失败后按 TTL 重探并返回新 runtime', async () => {
  let now = 3_000_000
  let available = false
  let resolveCalls = 0
  const harness = makeService({
    now: () => now,
    resolveRuntime: async () => {
      resolveCalls += 1
      if (!available) throw Object.assign(new Error('三路全不可用'), { code: 'unavailable' })
      return makeHandle('emulator')
    },
  })
  await assert.rejects(harness.service.status(), /三路全不可用/)
  assert.equal(resolveCalls, 1)

  available = true
  now += 30_000
  const status = await harness.service.status()
  assert.equal(resolveCalls, 2)
  assert.equal(status.runtime, 'emulator')
  assert.equal(status.platform, 'linux')
})

test('配置变化（onboarding.choice / runtime）立即使缓存失效并重探', async () => {
  let resolveCalls = 0
  const config = makeConfig({ runtime: 'attach' })
  const harness = makeService({
    config: () => config,
    resolveRuntime: async () => {
      resolveCalls += 1
      return makeHandle(config.onboarding?.choice === 'emulator' ? 'emulator' : 'attach')
    },
  })

  const first = await harness.service.status()
  assert.equal(first.runtime, 'attach')
  assert.equal(resolveCalls, 1)

  // volatile 热更新：onboarding.choice 变化 → 下一次 status 立即重探
  config.onboarding = { status: 'accepted', choice: 'emulator' }
  const second = await harness.service.status()
  assert.equal(resolveCalls, 2)
  assert.equal(second.runtime, 'emulator')

  // runtime 配置变化同样失效
  config.runtime = 'auto'
  await harness.service.status()
  assert.equal(resolveCalls, 3)
})

test('adapter 不可用（未运行/未 paused 且 stopped）→ handle 失效，下次调用重探', async () => {
  let resolveCalls = 0
  const harness = makeService({
    resolveRuntime: async () => {
      resolveCalls += 1
      return makeHandle('attach', {
        status: async () => ({
          kind: 'attach',
          running: false,
          paused: false,
          owned: false,
          adopted: true,
          endpoint: { host: '127.0.0.1', port: 5555 },
        }),
      })
    },
  })
  await harness.service.ensureRunning()
  assert.equal(resolveCalls, 1)

  // 生命周期回到 stopped 且 adapter 不可用 → status 内部失效 handle
  harness.lifecycle.emit('stopped')
  await harness.service.status()
  assert.equal(resolveCalls, 1)

  // 下一次调用重新探测
  await harness.service.status()
  assert.equal(resolveCalls, 2)
})

test('启动失败丢弃 handle：下一次 ensureRunning 立即重探（不受 30s 探测防抖限制）', async () => {
  let resolveCalls = 0
  let startFails = true
  const harness = makeService({
    resolveRuntime: async () => {
      resolveCalls += 1
      return makeHandle('attach', {
        ensureRunning: async () => {
          if (startFails) throw Object.assign(new Error('attach 端点不可达'), { code: 'start' })
          return { host: '127.0.0.1', port: 5555 }
        },
      })
    },
  })

  await assert.rejects(harness.service.ensureRunning(), /attach 端点不可达/)
  assert.equal(resolveCalls, 1)

  startFails = false
  await harness.service.ensureRunning()
  assert.equal(resolveCalls, 2)
  assert.equal(harness.lifecycle.state, 'running')
})
test('视频流/控制通道接线：startStream 收到 AdbConnection 本身，而不是 .raw（issue #59）', async () => {
  const connection: AdbConnectionLike = {
    raw: { fake: 'tango-adb' },
    disconnected: new Promise<void>(() => {}),
    close: async () => {},
  }
  const harness = makeService({ connect: async () => connection })

  // 无 viewer 的中文输入 → control-only 会话
  await harness.service.inputText('你好，世界')
  assert.equal(harness.streams.length, 1)
  assert.equal(harness.streams[0]!.video, false)
  assert.equal(harness.streams[0]!.adb, connection, 'control-only 必须收到 AdbConnection 本身')
  assert.notEqual(harness.streams[0]!.adb, connection.raw, '不得再传 connection.raw')

  // 有人看面板 → 视频会话
  await harness.service.startStream({ video: () => {}, error: () => {} })
  assert.equal(harness.streams.length, 2)
  assert.equal(harness.streams[1]!.video, true)
  assert.equal(harness.streams[1]!.adb, connection, '视频会话必须收到 AdbConnection 本身')
  assert.notEqual(harness.streams[1]!.adb, connection.raw, '不得再传 connection.raw')
})
/* --------------------- issue #70：attach.endpoint 生效 / R4b 真实验证 --------------------- */

function endpointOf(value: string): { host: string; port: number } {
  const index = value.lastIndexOf(':')
  return { host: value.slice(0, index), port: Number(value.slice(index + 1)) }
}

function makeEndpointHarness(options: {
  config: ServiceConfig
  failPorts?: number[]
}): {
  harness: ReturnType<typeof makeService>
  connected: { host: string; port: number }[]
} {
  const connected: { host: string; port: number }[] = []
  const config = options.config
  const handle: RuntimeHandle = {
    adapter: {
      kind: 'attach',
      probe: async () => ({ ok: true }),
      ensureRunning: async () => endpointOf(config.attach.endpoint),
      pause: async () => {},
      resume: async () => {},
      stop: async () => {},
      status: async () => ({
        kind: 'attach',
        running: true,
        paused: false,
        owned: false,
        adopted: true,
        endpoint: endpointOf(config.attach.endpoint),
      }),
      isAlive: async () => true,
    },
    detection: { kind: 'attach', platform: 'linux' },
  }
  const harness = makeService({
    config: () => config,
    resolveRuntime: async () => handle,
    connect: async (endpoint) => {
      if ((options.failPorts ?? []).includes(endpoint.port)) {
        throw new Error('connect ECONNREFUSED ' + endpoint.port)
      }
      connected.push({ ...endpoint })
      return {
        raw: { fake: 'adb' },
        disconnected: new Promise<void>(() => {}),
        close: async () => {},
      }
    },
  })
  return { harness, connected }
}

test('写新 attach.endpoint 后 ensureRunning 不走 running 快路径：重连新端点', async () => {
  const config = makeConfig({
    attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
  })
  const { harness, connected } = makeEndpointHarness({ config })
  await harness.service.ensureRunning()
  assert.deepEqual(connected.map((item) => item.port), [5555])

  // 模拟 POST /config 写入新 endpoint（volatile 实时生效）
  config.attach.endpoint = '127.0.0.1:5557'
  await harness.service.ensureRunning()

  assert.deepEqual(connected.map((item) => item.port), [5555, 5557], '必须连接新端点')
  assert.equal(harness.lifecycle.state, 'running')
  const status = await harness.service.status()
  assert.equal(status.endpoint?.port, 5557, 'status 必须显示新端点')
})

test('reconnectAndVerify（R4b）：强制丢弃旧连接 → 连新端点 → 新连接上 getprop 验证', async () => {
  const config = makeConfig({
    attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
  })
  const { harness, connected } = makeEndpointHarness({ config })
  await harness.service.ensureRunning()
  const disconnectedBefore = harness.disconnected

  config.attach.endpoint = '127.0.0.1:5557'
  const status = await harness.service.reconnectAndVerify()

  assert.deepEqual(connected.map((item) => item.port), [5555, 5557])
  assert.ok(harness.disconnected > disconnectedBefore, '旧 ADB 连接必须被断开')
  assert.ok(
    harness.calls.includes('shell:getprop ro.product.model'),
    '必须在新连接上执行 getprop 真实验证',
  )
  assert.equal(status.state, 'running')
  assert.equal(status.endpoint?.port, 5557)
})

test('reconnectAndVerify：新端点连接失败 → 返回 stopped + lastError（供 HTTP 映射 502，不假通过）', async () => {
  const config = makeConfig({
    attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
  })
  const { harness } = makeEndpointHarness({ config, failPorts: [5557] })
  await harness.service.ensureRunning()

  config.attach.endpoint = '127.0.0.1:5557'
  const status = await harness.service.reconnectAndVerify()
  assert.equal(status.state, 'stopped')
  assert.match(status.lastError ?? '', /ECONNREFUSED|5557/)
})

test('runtimeConfigFingerprint：attach.endpoint/resolved 变化也计入指纹', async () => {
  const { runtimeConfigFingerprint } = await import('../../src/phone/service.ts')
  const base = makeConfig({
    attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
  })
  const changedEndpoint = {
    ...base,
    attach: { ...base.attach, endpoint: '127.0.0.1:5557' },
  }
  const changedResolved = {
    ...base,
    attach: { ...base.attach, resolved: false },
  }
  assert.notEqual(runtimeConfigFingerprint(base), runtimeConfigFingerprint(changedEndpoint))
  assert.notEqual(runtimeConfigFingerprint(base), runtimeConfigFingerprint(changedResolved))
})
/* --------------- issue #73：viewer 引用计数/代际/心跳/暂停否决 --------------- */

test('viewer 存活心跳：周期性 touch，idle 不会在有人观看时休眠', async () => {
  const harness = makeService()
  const sink = { video: () => {}, error: () => {} }
  await harness.service.startStream(sink)
  const heartbeat = harness.schedule.find((item) => item.ms === 60_000)
  assert.ok(heartbeat, 'startStream 后必须安排 60s viewer 心跳')
  const touchesBefore = harness.lifecycle.touchCalls
  heartbeat!.callback!()
  assert.ok(harness.lifecycle.touchCalls > touchesBefore, '心跳必须 touch 生命周期')
  assert.equal(harness.sessions[0]!.closeCalls, 0, '心跳不得关流')
  assert.ok(harness.schedule.some((item) => item.ms === 60_000), '心跳必须续期')
})

test('viewer 输入/按键算交互（issue #73）', async () => {
  const harness = makeService()
  await harness.service.startStream({ video: () => {}, error: () => {} })
  const touchesBefore = harness.lifecycle.touchCalls
  await harness.service.touchScreen('down', 10, 20)
  await harness.service.key('HOME')
  await harness.service.inputText('你好')
  assert.equal(harness.lifecycle.touchCalls, touchesBefore + 3)
})

test('旧代际 release 不得关掉新流（issue #73）', async () => {
  const harness = makeService()
  const releaseFirst = await harness.service.startStream({ video: () => {}, error: () => {} })
  const releaseSecond = await harness.service.startStream({ video: () => {}, error: () => {} })

  // 第二次 startStream 替换旧会话
  assert.equal(harness.sessions.length, 2)
  assert.equal(harness.sessions[0]!.closeCalls, 1, '旧会话被替换关闭')
  assert.equal(harness.sessions[1]!.closeCalls, 0)

  await releaseFirst() // 旧代际 release：必须忽略
  assert.equal(harness.sessions[1]!.closeCalls, 0)
  assert.equal(harness.schedule.filter((item) => item.ms === 5000).length, 0, '旧 release 不得安排关流')

  await releaseSecond()
  const close = harness.schedule.find((item) => item.ms === 5000)
  assert.ok(close)
  close!.callback!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.sessions[1]!.closeCalls, 1)
})

test('viewer 存活时 idle 暂停被否决：保持 running/不关流（issue #73）', async () => {
  const harness = makeService()
  const release = await harness.service.startStream({ video: () => {}, error: () => {} })
  await assert.rejects(harness.lifecycle.hooks.pause!(), /viewer 正在观看/)
  assert.equal(harness.sessions[0]!.closeCalls, 0, '否决 pause 时不得关流')
  assert.equal(harness.adapter.pauseCalls, 0)

  // viewer 离开 → 5s 宽限关流；之后 pause 正常执行
  await release()
  const closeTimer = harness.schedule.find((item) => item.ms === 5000)
  assert.ok(closeTimer)
  closeTimer!.callback!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.sessions[0]!.closeCalls, 1)
  await harness.lifecycle.hooks.pause!()
  assert.equal(harness.adapter.pauseCalls, 1)
})
