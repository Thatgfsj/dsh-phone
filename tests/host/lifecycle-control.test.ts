import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LifecycleController } from '../../src/phone/lifecycle-control.ts'
import type { LifecycleServiceLike, RuntimeAction } from '../../src/phone/lifecycle-control.ts'
import type { PhoneStatus } from '../../src/phone/contracts.ts'

function status(overrides: Partial<PhoneStatus> = {}): PhoneStatus {
  return { state: 'running', runtime: 'emulator', platform: 'linux', ...overrides }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('info：映射 state/running/owned/adopted/pid/endpoint/since/lastError', async () => {
  const service: LifecycleServiceLike = {
    async status() {
      return status({
        state: 'paused',
        owned: true,
        adopted: false,
        pid: 4321,
        endpoint: { host: '127.0.0.1', port: 5555 },
        since: 123,
        lastError: 'boot warning',
      })
    },
  }
  const info = await new LifecycleController(service).info()
  assert.deepEqual(info, {
    state: 'paused',
    running: true,
    owned: true,
    adopted: false,
    pid: 4321,
    endpoint: { host: '127.0.0.1', port: 5555 },
    since: 123,
    busy: false,
    lastError: 'boot warning',
  })
})

test('info：adopted 实例与 stopped 状态', async () => {
  const service: LifecycleServiceLike = {
    async status() {
      return status({ state: 'stopped', owned: false, adopted: true, pid: 99 })
    },
  }
  const info = await new LifecycleController(service).info()
  assert.equal(info.running, false)
  assert.equal(info.owned, false)
  assert.equal(info.adopted, true)
  assert.equal(info.pid, 99)
})

test('start：优先调用 PhoneService.start；缺失时回退 ensureRunning', async () => {
  const calls: string[] = []
  const controller = new LifecycleController({
    async status() {
      return status()
    },
    async start() {
      calls.push('start')
    },
  })
  controller.enqueue('start')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['start'])

  const fallback: string[] = []
  const controller2 = new LifecycleController({
    async status() {
      return status()
    },
    async ensureRunning() {
      fallback.push('ensureRunning')
    },
  })
  controller2.enqueue('start')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fallback, ['ensureRunning'])
})

test('stop：无 stop 能力 → lastError E_STOP_FAILED；有 stop 时调用一次', async () => {
  const unsupported = new LifecycleController({
    async status() {
      return status()
    },
  })
  unsupported.enqueue('stop')
  await new Promise((resolve) => setImmediate(resolve))
  const info = await unsupported.info()
  assert.match(info.lastError ?? '', /^E_STOP_FAILED: /)

  const calls: { force?: boolean }[] = []
  const supported = new LifecycleController({
    async status() {
      return status()
    },
    async stop(options) {
      calls.push(options ?? {})
    },
  })
  supported.enqueue('stop')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [{ force: false }])
  assert.equal((await supported.info()).lastError, undefined)
})

test('restart：优先 restart；缺失时 stop → start 串行执行', async () => {
  const calls: string[] = []
  const controller = new LifecycleController({
    async status() {
      return status()
    },
    async restart() {
      calls.push('restart')
    },
  })
  controller.enqueue('restart')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['restart'])

  const fallback: string[] = []
  const controller2 = new LifecycleController({
    async status() {
      return status()
    },
    async stop() {
      fallback.push('stop')
    },
    async ensureRunning() {
      fallback.push('ensureRunning')
    },
  })
  controller2.enqueue('restart')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fallback, ['stop', 'ensureRunning'])
})

test('动作单队列互斥：并发 start/stop 串行，busy 反映队列长度', async () => {
  const first = deferred()
  const started: string[] = []
  let concurrent = 0
  let maxConcurrent = 0
  const service: LifecycleServiceLike = {
    async status() {
      return status({ state: 'stopped' })
    },
    async start() {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      started.push('start')
      await first.promise
      concurrent -= 1
    },
    async stop() {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      started.push('stop')
      concurrent -= 1
    },
  }
  const controller = new LifecycleController(service)
  controller.enqueue('start')
  controller.enqueue('stop')
  await new Promise((resolve) => setImmediate(resolve))
  const busy = await controller.info()
  assert.equal(busy.busy, true)
  assert.deepEqual(started, ['start'], '第二个动作必须排队等待')
  first.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(started, ['start', 'stop'])
  assert.equal(maxConcurrent, 1)
  assert.equal((await controller.info()).busy, false)
})

test('动作失败 → lastError 带动作对应错误码；成功后清除', async () => {
  let fail = true
  const controller = new LifecycleController({
    async status() {
      return status({ state: 'stopped' })
    },
    async start() {
      if (fail) throw new Error('emulator 起不来')
    },
  })
  controller.enqueue('start')
  await new Promise((resolve) => setImmediate(resolve))
  assert.match((await controller.info()).lastError ?? '', /^E_START_FAILED: emulator/)
  fail = false
  controller.enqueue('start')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await controller.info()).lastError, undefined)
})

test('dispose：不再接受新动作', async () => {
  const actions: RuntimeAction[] = []
  const controller = new LifecycleController({
    async status() {
      return status()
    },
    async start() {
      actions.push('start')
    },
  })
  controller.dispose()
  controller.enqueue('start')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(actions, [])
})