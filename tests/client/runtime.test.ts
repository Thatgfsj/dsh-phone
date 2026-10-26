import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RuntimeApiError,
  actionProgressKey,
  describeOwnership,
  isActionAvailable,
  isRuntimeUnsupported,
  parseRuntimeView,
  stopActionKey,
  stopConfirmKey,
} from '../../src/client/runtime-api.ts'
import type { RuntimeApi, RuntimeView } from '../../src/client/runtime-api.ts'
import {
  RuntimePoller,
  describeRuntimeUi,
  isExternalStop,
  runtimeErrorKey,
  runtimeStateKey,
} from '../../src/client/runtime-flow.ts'
import { describeStageView } from '../../src/client/layout.ts'

function view(partial: Partial<RuntimeView> = {}): RuntimeView {
  return {
    state: 'running',
    running: true,
    owned: false,
    adopted: false,
    busy: false,
    ...partial,
  }
}

test('parseRuntimeView normalizes malformed lifecycle payloads', () => {
  assert.deepEqual(parseRuntimeView(undefined), {
    state: 'stopped',
    running: false,
    owned: false,
    adopted: false,
    pid: undefined,
    endpoint: undefined,
    since: undefined,
    busy: false,
    lastError: undefined,
  })
  const parsed = parseRuntimeView({
    state: 'running',
    running: true,
    owned: true,
    adopted: false,
    pid: 4242,
    endpoint: { host: '127.0.0.1', port: 5555 },
    busy: true,
    lastError: '',
  })
  assert.equal(parsed.state, 'running')
  assert.equal(parsed.owned, true)
  assert.deepEqual(parsed.endpoint, { host: '127.0.0.1', port: 5555 })
  assert.equal(parsed.pid, 4242)
  assert.equal(parsed.busy, true)
  assert.equal(parseRuntimeView({ state: 'weird' }).state, 'stopped')
})

test('ownership and stop copy distinguish owned from adopted instances', () => {
  assert.equal(describeOwnership(view({ owned: true })), 'owned')
  assert.equal(describeOwnership(view({ adopted: true })), 'adopted')
  assert.equal(describeOwnership(view()), 'unknown')
  assert.equal(stopActionKey(view({ owned: true })), 'runtime.action.stopOwned')
  assert.equal(stopActionKey(view({ adopted: true })), 'runtime.action.disconnect')
  assert.equal(stopConfirmKey(view({ owned: true })), 'runtime.confirm.stopOwned')
  assert.equal(stopConfirmKey(view({ adopted: true })), 'runtime.confirm.disconnect')
})

test('isActionAvailable follows the runtime state and busy flag', () => {
  const stopped = view({ state: 'stopped', running: false })
  assert.equal(isActionAvailable(stopped, 'start'), true)
  assert.equal(isActionAvailable(stopped, 'stop'), false)
  assert.equal(isActionAvailable(stopped, 'restart'), false)

  const running = view({ state: 'running' })
  assert.equal(isActionAvailable(running, 'start'), false)
  assert.equal(isActionAvailable(running, 'stop'), true)
  assert.equal(isActionAvailable(running, 'restart'), true)
  assert.equal(isActionAvailable(view({ state: 'booting', running: false }), 'stop'), true)

  assert.equal(isActionAvailable(view({ busy: true }), 'restart'), false)
  assert.equal(isActionAvailable(undefined, 'start'), false)
})

test('isExternalStop recognizes the host watchdog wording', () => {
  assert.equal(isExternalStop('实例已被外部关闭（pid 消失/端口关闭）'), true)
  assert.equal(isExternalStop('device killed externally'), true)
  assert.equal(isExternalStop('boot timeout'), false)
  assert.equal(isExternalStop(undefined), false)
})

test('describeRuntimeUi derives stopped/external/ownership/capabilities', () => {
  const owned = describeRuntimeUi(view({ state: 'stopped', running: false, owned: true, lastError: '实例已被外部关闭（pid 消失）' }))
  assert.equal(owned.available, true)
  assert.equal(owned.stopped, true)
  assert.equal(owned.external, true)
  assert.equal(owned.owned, true)
  assert.equal(owned.stopKey, 'runtime.action.stopOwned')
  assert.equal(owned.canStart, true)
  assert.equal(owned.canStop, false)
  assert.equal(owned.reason, '实例已被外部关闭（pid 消失）')

  const adopted = describeRuntimeUi(view({ state: 'running', adopted: true, endpoint: { host: '127.0.0.1', port: 5555 } }))
  assert.equal(adopted.adopted, true)
  assert.equal(adopted.stopKey, 'runtime.action.disconnect')
  assert.equal(adopted.canStop, true)
  assert.equal(adopted.canRestart, true)
  assert.equal(adopted.identity, '127.0.0.1:5555')

  const unsupported = describeRuntimeUi(undefined, new RuntimeApiError('E_NOT_FOUND', '404', 404))
  assert.equal(unsupported.available, false)
  assert.equal(unsupported.stopped, false)
})

test('runtimeStateKey and runtimeErrorKey map Host values to copy keys', () => {
  assert.equal(runtimeStateKey(view({ state: 'running' })), 'runtime.state.running')
  assert.equal(runtimeStateKey(view({ state: 'booting' })), 'runtime.state.booting')
  assert.equal(runtimeStateKey(view({ state: 'paused' })), 'runtime.state.paused')
  assert.equal(runtimeStateKey(undefined), 'runtime.state.stopped')
  assert.equal(actionProgressKey('restart'), 'runtime.busy.restart')
  assert.equal(runtimeErrorKey(new RuntimeApiError('E_DEVICE_DISCONNECTED', 'x')), 'runtime.error.disconnected')
  assert.equal(runtimeErrorKey(new RuntimeApiError('E_STOP_FAILED', 'x')), 'runtime.error.stopFailed')
  assert.equal(runtimeErrorKey(new RuntimeApiError('E_TIMEOUT', 'x')), 'runtime.error.timeout')
  assert.equal(runtimeErrorKey(new Error('boom')), 'runtime.error.generic')
})

test('isRuntimeUnsupported only claims old/disabled Hosts', () => {
  assert.equal(isRuntimeUnsupported(new RuntimeApiError('E_NOT_FOUND', '404', 404)), true)
  assert.equal(isRuntimeUnsupported(new RuntimeApiError('E_NO_WEB', 'no web', 403)), true)
  assert.equal(isRuntimeUnsupported(new RuntimeApiError('E_AUTH', 'auth', 401)), false)
  assert.equal(isRuntimeUnsupported(new Error('boom')), false)
})

test('describeStageView: stopped wins over stream errors and booting', () => {
  assert.equal(
    describeStageView({ status: 'closed', booting: false, error: 'boom', runtimeStopped: true }),
    'stopped',
  )
  assert.equal(describeStageView({ status: 'ready', booting: true, runtimeStopped: true }), 'stopped')
  assert.equal(describeStageView({ status: 'idle', booting: false }), 'connecting')
})

interface FakeTimer {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

function harness(views: (RuntimeView | Error)[]) {
  const timers: FakeTimer[] = []
  const received: RuntimeView[] = []
  const failures: unknown[] = []
  const api: RuntimeApi = {
    get: async () => {
      const next = views.shift()
      if (next === undefined) throw new Error('no view queued')
      if (next instanceof Error) throw next
      return next
    },
    act: async () => {},
  }
  const poller = new RuntimePoller({
    api,
    onView: (next) => received.push(next),
    onFailure: (error) => failures.push(error),
    setTimer: (callback, delayMs) => {
      const timer: FakeTimer = { callback, delayMs, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as FakeTimer).cancelled = true
    },
  })
  return { poller, timers, received, failures }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function runNext(timers: FakeTimer[]): Promise<void> {
  const timer = timers.find((item) => !item.cancelled)
  if (timer === undefined) return
  timer.cancelled = true
  timer.callback()
  await settle()
}

test('RuntimePoller polls at 3s idle and 1s while an action runs', async () => {
  const fake = harness([view(), view({ busy: true })])
  fake.poller.start()
  await settle()
  assert.equal(fake.received.length, 1)
  const idleTimer = fake.timers.find((item) => !item.cancelled)
  assert.equal(idleTimer?.delayMs, 3000)

  fake.poller.setFast(true)
  const fastTimer = fake.timers.find((item) => !item.cancelled)
  assert.equal(fastTimer?.delayMs, 1000)

  await runNext(fake.timers)
  assert.equal(fake.received.length, 2)
  fake.poller.dispose()
  assert.equal(fake.poller.polling, false)
})

test('RuntimePoller keeps polling through read failures and stops on dispose', async () => {
  const fake = harness([new Error('host hiccup'), view()])
  fake.poller.start()
  await settle()
  assert.equal(fake.failures.length, 1)
  await runNext(fake.timers)
  assert.equal(fake.received.length, 1)
  fake.poller.stop()
  assert.equal(fake.poller.polling, false)
  await runNext(fake.timers)
  assert.equal(fake.received.length, 1)
})

test('RuntimePoller.refresh reads immediately', async () => {
  const fake = harness([view({ state: 'stopped', running: false })])
  await fake.poller.refresh()
  assert.equal(fake.received[0]?.state, 'stopped')
})
