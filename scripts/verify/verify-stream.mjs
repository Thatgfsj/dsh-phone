#!/usr/bin/env node
/**
 * verify-stream：用 createStreamUpgradeRoute + 假 socket/服务跑 WS 协议验收。
 *
 * 覆盖（docs/protocol.md §2，issue #8）：
 * 1. 升级路由 path 固定 /dsh-phone/stream；鉴权拒绝返回 HTTP 403 并销毁 socket；
 * 2. hello → state:booting → ready（codec/maxSize/maxFps）→ state:running；
 * 3. DPH1 二进制帧头：magic "DPH1"、frameType（configuration/keyframe/delta）、pts@90kHz；
 * 4. visibility:false → release viewer，StreamSession 5s 宽限后才真正关流；
 * 5. socket 断开 → 立即 release + 5s 宽限关流（断开清理）；
 * 6. visibility:true → 重新开流（引用计数回 0→1）。
 *
 * 全部使用假 socket 与假 stream 服务，不需要真机 / scrcpy / 浏览器。
 */
import { createStreamUpgradeRoute, STREAM_PATH } from '../../src/stream/index.ts'
import { DEFAULT_STREAM_GRACE_MS, StreamSession } from '../../src/stream/session.ts'
import {
  FakeSocket,
  binaryFrames,
  flush,
  makeUpgradeRequest,
  parseServerFrames,
  textFrame,
  textFrames,
} from '../../tests/stream/helpers.ts'
import { Cleanup, assert, assertDeepEqual, assertEqual, evidence, runScript, step } from './shared/harness.mjs'

/** 可注入时钟：只推进 StreamSession 的 5s 宽限计时器，不真实等待。 */
function makeClock() {
  let now = 0
  const timers = []
  return {
    now: () => now,
    setTimeout(callback, delayMs) {
      const timer = { at: now + delayMs, callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true
    },
    advance(delayMs) {
      now += delayMs
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= now) {
          timer.cancelled = true
          timer.callback()
        }
      }
    },
  }
}

/** 等待若干轮微任务/定时器回调，观察异步清理是否完成。 */
async function tick() {
  await flush()
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await flush()
}

function makeHarness(options = {}) {
  const clock = makeClock()
  const state = {
    ensure: 0,
    starts: 0,
    stops: 0,
    session: undefined,
    sink: undefined,
    touches: [],
    keys: [],
    texts: [],
    errors: [],
  }
  state.session = new StreamSession({
    start: async (sink) => {
      state.starts += 1
      state.sink = sink
      return {
        stop: async () => {
          state.stops += 1
        },
        controller: {
          injectText: async () => {},
          injectTouch: async () => {},
          injectKey: async () => {},
        },
      }
    },
    graceMs: DEFAULT_STREAM_GRACE_MS,
    clock,
    onError: (error) => state.errors.push(error),
  })

  const service = {
    async ensureRunning() {
      state.ensure += 1
    },
    startStream: (sink) => state.session.addViewer(sink),
    async touch(action, x, y) {
      state.touches.push(action + ':' + x + ',' + y)
    },
    async key(name) {
      state.keys.push(name)
    },
    async inputText(text) {
      state.texts.push(text)
    },
  }

  const route = createStreamUpgradeRoute({
    service,
    // 鉴权 fence：返回 undefined 表示放行，401/403 表示拒绝。
    getConnection: () => ({ requestRejection: () => options.rejection }),
    getStreamOptions: () => ({ maxSize: 720, maxFps: 15, bitrate: 2_000_000 }),
  })
  return { clock, state, route }
}

function open(socket, route) {
  route.handler(makeUpgradeRequest(), socket.asDuplex(), Buffer.alloc(0))
}

async function send(socket, message) {
  socket.emit('data', Buffer.from(textFrame(message)))
  await tick()
}

function closeCode(socket) {
  const frame = parseServerFrames(socket.bytes()).find((item) => item.opcode === 0x8)
  if (!frame || frame.payload.byteLength < 2) return undefined
  return ((frame.payload[0] << 8) | frame.payload[1])
}

const cleanup = new Cleanup()

await runScript(async () => {
  await step('路由 path 固定为 /dsh-phone/stream', () => {
    const { route } = makeHarness()
    assertEqual(route.path, STREAM_PATH, 'route.path')
    assertEqual(STREAM_PATH, '/dsh-phone/stream', 'STREAM_PATH 必须与 docs/protocol.md 一致')
  })

  await step('鉴权拒绝：requestRejection=403 → HTTP 403 + socket 销毁', async () => {
    const { route, state } = makeHarness({ rejection: 403 })
    const socket = new FakeSocket()
    open(socket, route)
    await tick()
    assert(/^HTTP\/1\.1 403 Forbidden/.test(socket.text()), '必须返回 HTTP 403')
    assertEqual(socket.destroyed, true, '拒绝后必须销毁 socket')
    assertEqual(state.ensure, 0, '拒绝时不得触发 ensureRunning')
    cleanup.register('销毁鉴权测试 socket', () => socket.destroy())
  })

  const harness = makeHarness()
  const socket = new FakeSocket()
  cleanup.register('销毁主流程 socket', () => socket.destroy())
  open(socket, harness.route)
  await tick()

  await step('握手：101 → hello → booting/ready/running', async () => {
    assert(/^HTTP\/1\.1 101 Switching Protocols/.test(socket.text()), '必须完成 101 握手')
    await send(socket, { type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 }, visible: true })
    assertEqual(harness.state.ensure, 1, 'hello 后 ensureRunning 必须被调用一次')
    assertEqual(harness.state.starts, 1, 'hello 后必须开流一次')
    assertEqual(harness.state.session.viewerCount, 1, 'viewer 计数必须为 1')
    const messages = textFrames(socket.bytes())
    assert(messages.some((message) => message.type === 'state' && message.state === 'booting'), '必须收到 state:booting')
    const ready = messages.find((message) => message.type === 'ready')
    assert(ready !== undefined, '必须收到 ready')
    assertEqual(ready.codec, 'h264', 'ready.codec')
    assertEqual(ready.width, 720, 'ready.width（hello viewport 回声）')
    assertEqual(ready.height, 1280, 'ready.height（hello viewport 回声）')
    assertEqual(ready.maxSize, 720, 'ready.maxSize')
    assertEqual(ready.maxFps, 15, 'ready.maxFps')
    assert(messages.some((message) => message.type === 'state' && message.state === 'running'), '必须收到 state:running')
    evidence('handshake', '101 → state:booting → ready(h264,720p,15fps) → state:running')
  })

  await step('DPH1 帧头：magic / frameType / pts@90kHz / 零转码负载', async () => {
    const configuration = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e])
    harness.state.sink.video(configuration)
    let frames = binaryFrames(socket.bytes())
    assertEqual(frames.length, 1, 'configuration 包应产生 1 条 WS binary')
    const configFrame = frames[0]
    assertDeepEqual([...configFrame.subarray(0, 4)], [0x44, 0x50, 0x48, 0x31], 'DPH1 magic')
    assertEqual(configFrame[4] >> 4, 0, 'configuration frameType=0')
    assertDeepEqual([...configFrame.subarray(8)], [...configuration], 'H.264 负载必须逐字节透传（Host 零转码）')

    const keyframe = new Uint8Array([0, 0, 0, 1, 0x65, 0x88])
    harness.state.sink.video(keyframe, { keyframe: true, pts: 1_000_000n })
    frames = binaryFrames(socket.bytes())
    const keyFrame = frames.at(-1)
    assertEqual(keyFrame[4] >> 4, 1, 'keyframe frameType=1')
    const meta = ((keyFrame[4] & 0x0f) << 24) | (keyFrame[5] << 16) | (keyFrame[6] << 8) | keyFrame[7]
    assertEqual(meta & 0x0fffffff, 90000, 'pts: 1_000_000µs → 90000 ticks（90kHz）')
    assertDeepEqual([...keyFrame.subarray(8)], [...keyframe], 'keyframe 负载逐字节透传')

    harness.state.sink.video(new Uint8Array([0, 0, 0, 1, 0x41]), { keyframe: false, pts: 2_000_000n })
    const deltaFrame = binaryFrames(socket.bytes()).at(-1)
    assertEqual(deltaFrame[4] >> 4, 2, 'delta frameType=2')
    evidence('DPH1', 'magic=DPH1, frameType 0/1/2, pts 90000@90kHz, payload byte-identical')
  })

  await step('visibility:false：release viewer，5s 宽限后才关流', async () => {
    await send(socket, { type: 'visibility', visible: false })
    assertEqual(harness.state.session.viewerCount, 0, 'visibility:false 后 viewer 计数必须归零')
    assertEqual(harness.state.stops, 0, '5s 宽限内不得停流')
    assert(
      textFrames(socket.bytes()).some((message) => message.type === 'state' && message.state === 'paused'),
      '必须回 state:paused',
    )
    harness.clock.advance(DEFAULT_STREAM_GRACE_MS - 1)
    await tick()
    assertEqual(harness.state.stops, 0, '宽限未到（4999ms）不得停流')
    harness.clock.advance(1)
    await tick()
    assertEqual(harness.state.stops, 1, '宽限到期（5000ms）必须停流')
    evidence('grace', DEFAULT_STREAM_GRACE_MS + 'ms 宽限（4999ms 不停流，5000ms 停流）')
  })

  await step('visibility:true：重新开流（引用计数 0→1）', async () => {
    await send(socket, { type: 'visibility', visible: true })
    assertEqual(harness.state.starts, 2, '重新可见必须再次开流')
    assertEqual(harness.state.session.viewerCount, 1, 'viewer 计数必须回到 1')
    const messages = textFrames(socket.bytes())
    assert(messages.filter((message) => message.type === 'ready').length >= 2, '重新开流后必须再收到 ready')
  })

  await step('断开清理：socket close → release + 5s 宽限停流', async () => {
    socket.destroy()
    await tick()
    assertEqual(harness.state.session.viewerCount, 0, '断开后 viewer 计数必须归零')
    assertEqual(harness.state.stops, 1, '断开后宽限内不得立即停流')
    harness.clock.advance(DEFAULT_STREAM_GRACE_MS)
    await tick()
    assertEqual(harness.state.stops, 2, '断开 + 宽限到期必须停流')
    assertEqual(harness.state.errors.length, 0, '主流程不应产生流错误: ' + harness.state.errors.map((error) => error.message).join('; '))
    evidence('disconnect', 'close → release → 5s 后 stop，无未处理错误')
  })
}, cleanup)
