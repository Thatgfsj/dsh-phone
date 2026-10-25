import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProvisionApiError,
  createFetchProvisionApi,
  isProvisionUnsupported,
  parseProvisionStatus,
  provisionStepKey,
  recentLog,
} from '../../src/client/provision-api.ts'
import type { ProvisionApi, ProvisionStatus } from '../../src/client/provision-api.ts'
import {
  ProvisionPoller,
  describeProvision,
  shouldAutoAccept,
} from '../../src/client/provision-flow.ts'

function status(partial: Partial<ProvisionStatus>): ProvisionStatus {
  return {
    state: 'running',
    step: 'install',
    percent: 10,
    log: [],
    ...partial,
  }
}

test('parseProvisionStatus normalizes hostile/malformed values', () => {
  assert.deepEqual(parseProvisionStatus(undefined), {
    state: 'idle',
    step: 'idle',
    percent: 0,
    log: [],
    error: undefined,
    runtime: undefined,
  })
  const parsed = parseProvisionStatus({
    state: 'running',
    step: 'install',
    percent: 130.4,
    log: ['a', 42, 'b'],
    error: '',
    runtime: 'emulator',
  })
  assert.equal(parsed.state, 'running')
  assert.equal(parsed.percent, 100)
  assert.deepEqual(parsed.log, ['a', 'b'])
  assert.equal(parsed.error, undefined)
  assert.equal(parseProvisionStatus({ state: 'nope', percent: -5 }).percent, 0)
})

test('recentLog returns the tail lines only', () => {
  assert.deepEqual(recentLog(['1', '2', '3', '4', '5', '6']), ['2', '3', '4', '5', '6'])
  assert.deepEqual(recentLog(['1', '2', '3', '4', '5', '6'], 3), ['4', '5', '6'])
  assert.deepEqual(recentLog([]), [])
})

test('provisionStepKey maps known phases and degrades unknown ones', () => {
  assert.equal(provisionStepKey('precheck'), 'provision.step.precheck')
  assert.equal(provisionStepKey('install'), 'provision.step.install')
  assert.equal(provisionStepKey('licenses'), 'provision.step.licenses')
  assert.equal(provisionStepKey('avd'), 'provision.step.avd')
  assert.equal(provisionStepKey('verify'), 'provision.step.verify')
  assert.equal(provisionStepKey('done'), 'provision.step.done')
  assert.equal(provisionStepKey('failed'), 'provision.step.failed')
  assert.equal(provisionStepKey('mystery'), 'provision.step.working')
})

test('isProvisionUnsupported detects old/disabled Hosts only', () => {
  assert.equal(isProvisionUnsupported(new ProvisionApiError('E_NOT_FOUND', '404', 404)), true)
  assert.equal(isProvisionUnsupported(new ProvisionApiError('E_NO_WEB', 'no web', 403)), true)
  assert.equal(isProvisionUnsupported(new ProvisionApiError('E_BAD_REQUEST', 'bad', 400)), true)
  assert.equal(isProvisionUnsupported(new ProvisionApiError('E_AUTH', 'auth', 401)), false)
  assert.equal(isProvisionUnsupported(new Error('boom')), false)
})

test('describeProvision derives active/done/failed/available', () => {
  assert.deepEqual(describeProvision(), {
    available: true,
    active: false,
    done: false,
    failed: false,
    status: undefined,
  })
  assert.equal(describeProvision(status({ state: 'running' })).active, true)
  assert.equal(describeProvision(status({ state: 'done' })).done, true)
  assert.equal(describeProvision(status({ state: 'failed', error: 'x' })).failed, true)
  const unsupported = describeProvision(undefined, new ProvisionApiError('E_NOT_FOUND', '404', 404))
  assert.equal(unsupported.available, false)
  assert.equal(unsupported.active, false)
})

test('shouldAutoAccept enables pending onboarding only when provisioning is done', () => {
  const done = describeProvision(status({ state: 'done' }))
  assert.equal(shouldAutoAccept(done, 'pending'), true)
  assert.equal(shouldAutoAccept(done, 'accepted'), false)
  assert.equal(shouldAutoAccept(done, 'declined'), false)
  assert.equal(shouldAutoAccept(describeProvision(status({ state: 'failed' })), 'pending'), false)
})

interface FakeTimer {
  callback: () => void
  cancelled: boolean
}

function harness(responses: ({ status: ProvisionStatus } | Error)[]) {
  const timers: FakeTimer[] = []
  const statuses: ProvisionStatus[] = []
  const failures: unknown[] = []
  const calls: string[] = []
  const api: ProvisionApi = {
    get: async () => {
      calls.push('get')
      const next = responses.shift()
      if (next === undefined) throw new Error('no response queued')
      if (next instanceof Error) throw next
      return next.status
    },
    start: async (runtime) => {
      calls.push('start:' + runtime)
      const next = responses.shift()
      if (next === undefined) throw new Error('no response queued')
      if (next instanceof Error) throw next
      return next.status
    },
  }
  const poller = new ProvisionPoller({
    api,
    onStatus: (next) => statuses.push(next),
    onFailure: (error) => failures.push(error),
    setTimer: (callback) => {
      const timer: FakeTimer = { callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as FakeTimer).cancelled = true
    },
  })
  return { poller, timers, statuses, failures, calls, responses }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function runNextTimer(timers: FakeTimer[]): Promise<void> {
  const timer = timers.find((item) => !item.cancelled)
  if (timer === undefined) return
  timer.cancelled = true
  timer.callback()
  await settle()
}

test('ProvisionPoller.start posts, then polls until done and stops', async () => {
  const fake = harness([
    { status: status({ state: 'running', percent: 10 }) },
    { status: status({ state: 'running', percent: 55 }) },
    { status: status({ state: 'done', percent: 100 }) },
  ])
  await fake.poller.start()
  await settle()
  assert.deepEqual(fake.calls, ['start:emulator'])
  assert.equal(fake.poller.polling, true)
  assert.equal(fake.statuses.at(-1)?.percent, 10)
  await runNextTimer(fake.timers)
  assert.equal(fake.statuses.at(-1)?.percent, 55)
  assert.equal(fake.poller.polling, true)
  await runNextTimer(fake.timers)
  assert.equal(fake.statuses.at(-1)?.state, 'done')
  assert.equal(fake.poller.polling, false)
})

test('ProvisionPoller.start does not poll when the job is already done', async () => {
  const fake = harness([{ status: status({ state: 'done' }) }])
  await fake.poller.start()
  await settle()
  assert.equal(fake.poller.polling, false)
  assert.equal(fake.statuses.at(-1)?.state, 'done')
})

test('ProvisionPoller.probe reads once, resumes polling only while running', async () => {
  const doneFake = harness([{ status: status({ state: 'done' }) }])
  const doneStatus = await doneFake.poller.probe()
  await settle()
  assert.equal(doneStatus?.state, 'done')
  assert.equal(doneFake.poller.polling, false)

  const runningFake = harness([{ status: status({ state: 'running' }) }, { status: status({ state: 'failed', error: 'boom' }) }])
  await runningFake.poller.probe()
  await settle()
  assert.equal(runningFake.poller.polling, true)
  await runNextTimer(runningFake.timers)
  assert.equal(runningFake.statuses.at(-1)?.state, 'failed')
  assert.equal(runningFake.poller.polling, false)
})

test('ProvisionPoller surfaces failures and stops polling', async () => {
  const fake = harness([new Error('no host')])
  await fake.poller.start()
  await settle()
  assert.equal(fake.failures.length, 1)
  assert.equal(fake.poller.polling, false)

  const running = harness([
    { status: status({ state: 'running' }) },
    new Error('lost host'),
  ])
  await running.poller.start()
  await settle()
  assert.equal(running.poller.polling, true)
  await runNextTimer(running.timers)
  assert.equal(running.failures.length, 1)
  assert.equal(running.poller.polling, false)
})

test('ProvisionPoller.stopPolling cancels the pending tick; dispose is final', async () => {
  const fake = harness([{ status: status({ state: 'running' }) }, { status: status({ state: 'done' }) }])
  await fake.poller.start()
  await settle()
  fake.poller.stopPolling()
  assert.equal(fake.poller.polling, false)
  await runNextTimer(fake.timers)
  assert.equal(fake.statuses.length, 1, 'no status after stopping')
  fake.poller.dispose()
  await fake.poller.start()
  await settle()
  assert.equal(fake.statuses.length, 1, 'disposed poller ignores start')
})

test('createFetchProvisionApi uses the frozen paths and body', async () => {
  const original = globalThis.fetch
  const seen: { url: string; init?: RequestInit }[] = []
  try {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ ok: true, value: status({ state: 'running' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const api = createFetchProvisionApi()
    await api.get()
    await api.start('emulator')
    await api.start('emulator', 'aosp_atd')
    assert.deepEqual(seen.map((entry) => entry.url), [
      '/dsh-phone/api/provision',
      '/dsh-phone/api/provision',
      '/dsh-phone/api/provision',
    ])
    assert.deepEqual(JSON.parse(String(seen[1]!.init?.body)), { runtime: 'emulator' })
    assert.deepEqual(JSON.parse(String(seen[2]!.init?.body)), { runtime: 'emulator', image: 'aosp_atd' })
  } finally {
    globalThis.fetch = original
  }
})

test('createFetchProvisionApi surfaces protocol errors', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'E_NO_WEB', message: 'no web' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    await assert.rejects(
      () => createFetchProvisionApi().get(),
      (error: unknown) => error instanceof ProvisionApiError && error.code === 'E_NO_WEB' && error.status === 404,
    )
  } finally {
    globalThis.fetch = original
  }
})
