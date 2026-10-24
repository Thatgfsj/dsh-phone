import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BOOT_TIMEOUT_MS,
  BootStatusPoller,
  describeBootProgress,
} from '../../src/client/boot.ts'

test('describeBootProgress clamps and maps phases across the boot window', () => {
  const start = describeBootProgress(0)
  assert.equal(start.seconds, 0)
  assert.equal(start.percent, 0)
  assert.equal(start.phaseKey, 'panel.boot.phase.starting')
  assert.equal(start.timedOut, false)

  assert.equal(describeBootProgress(-500).bootMs, 0)
  assert.equal(describeBootProgress(Number.NaN).bootMs, 0)
  assert.equal(describeBootProgress(14_999).phaseKey, 'panel.boot.phase.starting')
  assert.equal(describeBootProgress(15_000).phaseKey, 'panel.boot.phase.warming')
  assert.equal(describeBootProgress(45_000).phaseKey, 'panel.boot.phase.firstBoot')
  assert.equal(describeBootProgress(90_000).phaseKey, 'panel.boot.phase.slow')

  const full = describeBootProgress(BOOT_TIMEOUT_MS)
  assert.equal(full.timedOut, true)
  assert.equal(full.percent, 100)
  assert.equal(full.seconds, 120)

  const over = describeBootProgress(BOOT_TIMEOUT_MS * 2)
  assert.equal(over.percent, 100, 'progress is capped at 100')
  assert.equal(over.seconds, 240, 'elapsed seconds keep counting')
})

test('describeBootProgress honours a custom ceiling', () => {
  const progress = describeBootProgress(5_000, 10_000)
  assert.equal(progress.percent, 50)
  assert.equal(progress.timedOut, false)
  assert.equal(describeBootProgress(10_000, 10_000).timedOut, true)
})

interface FakeTimer {
  callback: () => void
  cancelled: boolean
}

function harness(statuses: ({ state: string; bootMs?: number } | Error)[]) {
  let current = 0
  const timers: FakeTimer[] = []
  const progresses: ({ seconds: number; percent: number } | undefined)[] = []
  const poller = new BootStatusPoller({
    getStatus: async () => {
      const next = statuses.shift()
      if (next === undefined) throw new Error('no status queued')
      if (next instanceof Error) throw next
      return next
    },
    onProgress: (progress) =>
      progresses.push(progress === undefined ? undefined : { seconds: progress.seconds, percent: progress.percent }),
    setTimer: (callback) => {
      const timer: FakeTimer = { callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as FakeTimer).cancelled = true
    },
    now: () => current,
  })
  return {
    poller,
    progresses,
    timers,
    advance: (ms: number) => {
      current += ms
    },
    async runNextTimer(): Promise<void> {
      const timer = timers.find((item) => !item.cancelled)
      if (timer === undefined) return
      timer.cancelled = true
      timer.callback()
      await new Promise((resolve) => setImmediate(resolve))
    },
    async settle(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

test('BootStatusPoller reports bootMs once per second and stops when booting ends', async () => {
  const fake = harness([{ state: 'booting', bootMs: 1_200 }, { state: 'running', bootMs: 1_300 }])
  fake.poller.start()
  await fake.settle()
  assert.deepEqual(fake.progresses, [{ seconds: 1, percent: 1 }])
  assert.equal(fake.poller.running, true)
  await fake.runNextTimer()
  assert.deepEqual(fake.progresses[1], undefined, 'non-booting state clears the progress')
  assert.equal(fake.poller.running, false)
})

test('BootStatusPoller falls back to elapsed time when status omits bootMs', async () => {
  const fake = harness([{ state: 'booting' }, { state: 'booting' }])
  fake.poller.start()
  await fake.settle()
  assert.deepEqual(fake.progresses[0], { seconds: 0, percent: 0 })
  fake.advance(1_500)
  await fake.runNextTimer()
  assert.deepEqual(fake.progresses[1], { seconds: 1, percent: 1 })
})

test('BootStatusPoller keeps polling through transient status read failures', async () => {
  const fake = harness([new Error('host booting'), { state: 'booting', bootMs: 2_000 }])
  fake.poller.start()
  await fake.settle()
  // A transient failure keeps the loop alive and falls back to local elapsed time.
  assert.deepEqual(fake.progresses[0], { seconds: 0, percent: 0 })
  assert.equal(fake.poller.running, true)
  await fake.runNextTimer()
  assert.deepEqual(fake.progresses[1], { seconds: 2, percent: 2 })
})

test('BootStatusPoller.stop cancels the pending tick and further callbacks', async () => {
  const fake = harness([{ state: 'booting', bootMs: 500 }, { state: 'booting', bootMs: 900 }])
  fake.poller.start()
  await fake.settle()
  assert.equal(fake.progresses.length, 1)
  fake.poller.stop()
  assert.equal(fake.poller.running, false)
  assert.ok(fake.timers.every((timer) => timer.cancelled))
  await fake.runNextTimer()
  assert.equal(fake.progresses.length, 1)
})
