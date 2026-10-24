import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StreamSession } from '../../src/stream/session.ts'
import type { StreamHandle, StreamSink, StreamVideoMeta } from '../../src/stream/types.ts'

interface FakeClock {
  delays: number[]
  fire(): void
  pending(): number
}

function fakeClock(): FakeClock {
  let callback: (() => void) | undefined
  let handle: unknown
  const delays: number[] = []
  return {
    delays,
    fire() {
      const fn = callback
      callback = undefined
      handle = undefined
      fn?.()
    },
    pending() {
      return handle === undefined ? 0 : 1
    },
    setTimeout(cb: () => void, delayMs: number) {
      delays.push(delayMs)
      callback = cb
      handle = {}
      return handle
    },
    clearTimeout(h: unknown) {
      if (h === handle) {
        callback = undefined
        handle = undefined
      }
    },
  } as FakeClock
}

interface FakeHandle extends StreamHandle {
  stopped: number
}

function fakeHandle(): FakeHandle {
  const handle: FakeHandle = {
    stopped: 0,
    async stop() {
      handle.stopped += 1
    },
    controller: {
      async injectText() {},
      async injectTouch() {},
      async injectKey() {},
    },
  }
  return handle
}

function recorder(): { sink: StreamSink; frames: Uint8Array[]; errors: Error[] } {
  const frames: Uint8Array[] = []
  const errors: Error[] = []
  return {
    frames,
    errors,
    sink: {
      video(chunk: Uint8Array, _meta?: StreamVideoMeta) {
        frames.push(chunk)
      },
      error(error: Error) {
        errors.push(error)
      },
    },
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('首个 viewer 开流，多 viewer 共享同一会话', async () => {
  const clock = fakeClock()
  const handle = fakeHandle()
  let starts = 0
  let upstream: StreamSink | undefined
  const session = new StreamSession({
    start: async (sink) => {
      starts += 1
      upstream = sink
      return handle
    },
    clock: clock as never,
  })

  const a = recorder()
  const b = recorder()
  await session.addViewer(a.sink)
  await session.addViewer(b.sink)

  assert.equal(starts, 1)
  assert.equal(session.viewerCount, 2)
  upstream?.video(new Uint8Array([1]))
  assert.equal(a.frames.length, 1)
  assert.equal(b.frames.length, 1)
  await session.stopNow()
})

test('最后一个 viewer release 后宽限 5s 才 stop；期间新 viewer 复用会话', async () => {
  const clock = fakeClock()
  const handle = fakeHandle()
  let starts = 0
  const session = new StreamSession({
    start: async () => {
      starts += 1
      return handle
    },
    clock: clock as never,
  })

  const a = recorder()
  const releaseA = await session.addViewer(a.sink)
  await releaseA()
  assert.equal(handle.stopped, 0)
  assert.deepEqual(clock.delays, [5000])

  // 宽限期内加入新 viewer：取消计时器，不重新开流
  const b = recorder()
  const releaseB = await session.addViewer(b.sink)
  assert.equal(clock.pending(), 0)
  assert.equal(starts, 1)
  assert.equal(handle.stopped, 0)

  await releaseB()
  clock.fire()
  await flush()
  assert.equal(handle.stopped, 1)
  assert.equal(session.running, false)
})

test('并发 addViewer 单飞：只调用一次 start', async () => {
  const clock = fakeClock()
  const handle = fakeHandle()
  let starts = 0
  let resolveStart: ((value: StreamHandle) => void) | undefined
  const session = new StreamSession({
    start: () => {
      starts += 1
      return new Promise<StreamHandle>((resolve) => {
        resolveStart = resolve
      })
    },
    clock: clock as never,
  })

  const a = recorder()
  const b = recorder()
  const pa = session.addViewer(a.sink)
  const pb = session.addViewer(b.sink)
  await flush()
  assert.equal(starts, 1)
  resolveStart?.(handle)
  await Promise.all([pa, pb])
  assert.equal(session.viewerCount, 2)
  await session.stopNow()
})

test('启动失败时 viewer 不计入，错误向上抛且可重试', async () => {
  const clock = fakeClock()
  let attempts = 0
  const session = new StreamSession({
    start: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('E_STREAM_START_FAILED')
      return fakeHandle()
    },
    clock: clock as never,
  })

  const a = recorder()
  await assert.rejects(session.addViewer(a.sink), /E_STREAM_START_FAILED/)
  assert.equal(session.viewerCount, 0)

  await session.addViewer(a.sink)
  assert.equal(attempts, 2)
  assert.equal(session.viewerCount, 1)
  await session.stopNow()
})

test('会话异常通过 sink.error 广播，重复 release 幂等', async () => {
  const clock = fakeClock()
  let upstream: StreamSink | undefined
  const handle = fakeHandle()
  const session = new StreamSession({
    start: async (sink) => {
      upstream = sink
      return handle
    },
    clock: clock as never,
  })

  const a = recorder()
  const release = await session.addViewer(a.sink)
  upstream?.error(new Error('scrcpy server 异常退出'))
  assert.equal(a.errors.length, 1)

  await release()
  await release()
  assert.equal(session.viewerCount, 0)
  await session.stopNow()
  assert.equal(handle.stopped, 1)
})

test('stopNow 立即关流且幂等', async () => {
  const clock = fakeClock()
  const handle = fakeHandle()
  const session = new StreamSession({
    start: async () => handle,
    clock: clock as never,
  })
  await session.addViewer(recorder().sink)
  await session.stopNow()
  await session.stopNow()
  assert.equal(handle.stopped, 1)
  assert.equal(session.running, false)
})
