/**
 * DRAFT skeleton (not committed) for the lifecycle-acceptance follow-up issue.
 *
 * Runnable against current main: `node --test tests/client/lifecycle-acceptance.test.ts`.
 * Manual-only checks live in docs draft (kill -9 wall-clock, owned snapshot,
 * adopted process, dual page, plugin unload); this file covers the pure/client
 * testable parts so CI keeps the contract honest.
 *
 * The three client gaps from the draft are fixed here: runtimeErrorKey learned
 * E_RESTART_FAILED/E_LIFECYCLE_BUSY, actionDoneKey() is a pure helper, and the
 * Host busy flag is exposed for dual-page button disabling.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { zh, en } from '../../src/client/i18n.ts'
import { describeStageView } from '../../src/client/layout.ts'
import {
  RuntimeApiError,
  actionProgressKey,
  describeOwnership,
  isActionAvailable,
  stopActionKey,
  stopConfirmKey,
} from '../../src/client/runtime-api.ts'
import type { RuntimeApi, RuntimeView } from '../../src/client/runtime-api.ts'
import {
  RUNTIME_IDLE_POLL_MS,
  RUNTIME_ACTION_POLL_MS,
  RuntimePoller,
  actionDoneKey,
  describeRuntimeUi,
  isExternalStop,
  isRuntimeBusy,
  runtimeErrorKey,
} from '../../src/client/runtime-flow.ts'

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

// A. 外部 kill：视图从 running 翻成 stopped+lastError 时，UI 判定为 external，
//    且 stage 用 stopped 覆盖层（不再显示连接错误）。
test('A: external kill view maps to the stopped overlay with a reason', () => {
  const external = view({ state: 'stopped', running: false, lastError: '实例已被外部关闭（pid 消失/端口关闭）' })
  const ui = describeRuntimeUi(external)
  assert.equal(ui.stopped, true)
  assert.equal(ui.external, true)
  assert.equal(ui.canStart, true)
  assert.equal(isExternalStop(external.lastError), true)
  assert.equal(describeStageView({ status: 'closed', booting: false, error: 'stream error', runtimeStopped: true }), 'stopped')
})

test('A: idle polling detects an external kill within one 3s window', async () => {
  const timers: { callback: () => void; delayMs: number; cancelled: boolean }[] = []
  const views: RuntimeView[] = [
    view(),
    view({ state: 'stopped', running: false, lastError: '实例已被外部关闭（pid 消失）' }),
  ]
  const received: RuntimeView[] = []
  const api: RuntimeApi = {
    get: async () => {
      const next = views.shift()
      if (next === undefined) throw new Error('no view queued')
      return next
    },
    act: async () => {},
  }
  const poller = new RuntimePoller({
    api,
    onView: (next) => received.push(next),
    onFailure: () => assert.fail('unexpected poll failure'),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    },
  })
  poller.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.find((timer) => !timer.cancelled)?.delayMs, RUNTIME_IDLE_POLL_MS)
  const timer = timers.find((item) => !item.cancelled)!
  timer.cancelled = true
  timer.callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(received.length, 2)
  assert.equal(describeRuntimeUi(received[1]).external, true)
  poller.dispose()
})

// B/C. owned vs adopted 文案与动作可用性（防呆：文案不能混用）。
test('B/C: owned stops the phone; adopted only disconnects', () => {
  const owned = view({ owned: true })
  const adopted = view({ adopted: true, endpoint: { host: '127.0.0.1', port: 5555 } })
  assert.equal(describeOwnership(owned), 'owned')
  assert.equal(describeOwnership(adopted), 'adopted')
  assert.equal(stopActionKey(owned), 'runtime.action.stopOwned')
  assert.equal(stopActionKey(adopted), 'runtime.action.disconnect')
  assert.equal(stopConfirmKey(owned), 'runtime.confirm.stopOwned')
  assert.equal(stopConfirmKey(adopted), 'runtime.confirm.disconnect')
  assert.notEqual(stopActionKey(owned), stopActionKey(adopted))
  assert.equal(describeRuntimeUi(adopted).identity, '127.0.0.1:5555')
  // stop 只对非 stopped 可用；booting 中也允许取消启动。
  assert.equal(isActionAvailable(view({ state: 'booting', running: false }), 'stop'), true)
  assert.equal(isActionAvailable(view({ state: 'stopped', running: false }), 'start'), true)
  assert.equal(isActionAvailable(view({ busy: true }), 'restart'), false)
})

// D. 重启/动作进度：busy 期间禁用，完成后恢复；轮询切到 1s。
test('D: restart sequence keeps 1s polling while busy and updates capabilities', async () => {
  const timers: { callback: () => void; delayMs: number; cancelled: boolean }[] = []
  const views: RuntimeView[] = [
    view({ busy: true }),
    view({ state: 'stopped', running: false }),
    view({ state: 'booting', running: false }),
    view({ state: 'running' }),
  ]
  const received: RuntimeView[] = []
  const api: RuntimeApi = {
    get: async () => {
      const next = views.shift()
      if (next === undefined) throw new Error('no view queued')
      return next
    },
    act: async () => {},
  }
  const poller = new RuntimePoller({
    api,
    onView: (next) => received.push(next),
    onFailure: () => assert.fail('unexpected poll failure'),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    },
  })
  poller.setFast(true)
  poller.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.find((timer) => !timer.cancelled)?.delayMs, RUNTIME_ACTION_POLL_MS)
  for (let index = 0; index < 3; index += 1) {
    const timer = timers.find((item) => !item.cancelled)!
    timer.cancelled = true
    timer.callback()
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(
    received.map((next) => next.state),
    ['running', 'stopped', 'booting', 'running'],
  )
  // Host busy 期间按钮禁用（can* 为 false），完成后恢复。
  assert.equal(describeRuntimeUi(received[0]).canStop, false)
  assert.equal(describeRuntimeUi(received[0]).canRestart, false)
  assert.equal(describeRuntimeUi(received[1]).canStart, true)
  assert.equal(actionProgressKey('restart'), 'runtime.busy.restart')
  poller.dispose()
})

// G. 卸载/重载：dispose 后轮询停止；旧 Host 404 降级。
test('G: dispose stops polling; a 404 Host degrades to unavailable', async () => {
  const api: RuntimeApi = {
    get: async () => view(),
    act: async () => {},
  }
  const poller = new RuntimePoller({
    api,
    onView: () => assert.fail('no view expected after dispose'),
    onFailure: () => assert.fail('no failure expected after dispose'),
    setTimer: () => ({ cancelled: true }),
    clearTimer: () => {},
  })
  poller.start()
  poller.dispose()
  assert.equal(poller.polling, false)
  const unsupported = describeRuntimeUi(undefined, new RuntimeApiError('E_NOT_FOUND', '404', 404))
  assert.equal(unsupported.available, false)
})

// H. i18n：生命周期文案在 zh/en 都存在（防止按钮显示 key）。
test('H: lifecycle copy exists in both locales', () => {
  const keys = [
    'runtime.action.start',
    'runtime.action.restart',
    'runtime.action.recheck',
    'runtime.action.stopOwned',
    'runtime.action.disconnect',
    'runtime.confirm.stopOwned',
    'runtime.confirm.disconnect',
    'runtime.stopped.title',
    'runtime.stopped.externalTitle',
    'runtime.state.running',
    'runtime.busy.restart',
    'runtime.done.restart',
    'runtime.ownership.owned',
    'runtime.ownership.adopted',
    'runtime.error.startFailed',
    'runtime.error.stopFailed',
    'runtime.error.restartFailed',
    'runtime.error.busy',
    'runtime.busy.remote',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', 'zh missing ' + key)
    assert.equal(typeof en[key], 'string', 'en missing ' + key)
    assert.notEqual(zh[key], '', 'zh empty ' + key)
    assert.notEqual(en[key], '', 'en empty ' + key)
  }
})

// 现有错误码映射（follow-up 前应通过）。
test('H: current error-code mapping is readable', () => {
  assert.equal(runtimeErrorKey(new RuntimeApiError('E_START_FAILED', 'x')), 'runtime.error.startFailed')
  assert.equal(runtimeErrorKey(new RuntimeApiError('E_STOP_FAILED', 'x')), 'runtime.error.stopFailed')
  assert.equal(runtimeErrorKey(new RuntimeApiError('E_DEVICE_DISCONNECTED', 'x')), 'runtime.error.disconnected')
})

// H2. 协议 §1.5 动作错误码有专门文案（follow-up 缺口已修）。
test('H: E_RESTART_FAILED / E_LIFECYCLE_BUSY map to dedicated copy', () => {
  assert.equal(runtimeErrorKey(new RuntimeApiError('E_RESTART_FAILED', 'x')), 'runtime.error.restartFailed')
  assert.equal(runtimeErrorKey(new RuntimeApiError('E_LIFECYCLE_BUSY', 'x')), 'runtime.error.busy')
  assert.equal(typeof zh['runtime.error.restartFailed'], 'string')
  assert.equal(typeof en['runtime.error.restartFailed'], 'string')
  assert.equal(typeof zh['runtime.error.busy'], 'string')
  assert.equal(typeof en['runtime.error.busy'], 'string')
})

test('D2: actionDoneKey covers the three lifecycle actions', () => {
  assert.equal(actionDoneKey('start'), 'runtime.done.start')
  assert.equal(actionDoneKey('stop'), 'runtime.done.stop')
  assert.equal(actionDoneKey('restart'), 'runtime.done.restart')
})

// F2. 双页禁用态：Host 报 busy 时另一页的 can* 全部为 false，且 busy 合并函数正确。
test('F: Host busy disables lifecycle controls on every page', () => {
  const hostBusy = describeRuntimeUi(view({ busy: true }))
  assert.equal(hostBusy.busy, true)
  assert.equal(hostBusy.canStart, false)
  assert.equal(hostBusy.canStop, false)
  assert.equal(hostBusy.canRestart, false)
  assert.equal(isRuntimeBusy(hostBusy.busy, false), true)
  assert.equal(isRuntimeBusy(false, false), false)
  assert.equal(isRuntimeBusy(false, true), true)
  assert.equal(describeRuntimeUi(view()).busy, false)
})

// F. 双页/多面板：两个 poller 独立，停止一个不影响另一个（页面级互踢为 #81 手工验收）。
test('F: two page pollers are independent; stopping one leaves the other polling', async () => {
  const makePoller = () => {
    let stopped = false
    const poller = new RuntimePoller({
      api: { get: async () => view(), act: async () => {} },
      onView: () => {},
      onFailure: () => assert.fail('unexpected poll failure'),
      setTimer: () => ({ cancelled: true }),
      clearTimer: () => {
        stopped = true
      },
    })
    return { poller, wasStopped: () => stopped }
  }
  const a = makePoller()
  const b = makePoller()
  a.poller.start()
  b.poller.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(a.poller.polling, true)
  assert.equal(b.poller.polling, true)
  a.poller.stop()
  assert.equal(a.wasStopped(), true)
  assert.equal(b.poller.polling, true)
  b.poller.dispose()
})
