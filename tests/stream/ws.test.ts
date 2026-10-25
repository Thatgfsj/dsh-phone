import assert from 'node:assert/strict'
import { test } from 'node:test'

import { recordDeviceSize } from '../../src/stream/device-size.ts'
import { registerStreamRoute } from '../../src/stream/ws.ts'
import type { StreamRouteContext } from '../../src/stream/ws.ts'
import type { PhoneStreamService, StreamSink } from '../../src/stream/types.ts'
import {
  binaryFrames,
  clientFrame,
  FakeSocket,
  flush,
  makeUpgradeRequest,
  parseServerFrames,
  textFrame,
  textFrames,
} from './helpers.ts'

interface FakeUpgradeRoute {
  path: string
  handler: (req: Parameters<typeof makeUpgradeRequest>[0] extends never ? never : never, socket: never, head: Buffer) => void
}

interface CtxOptions {
  hasConnection?: boolean
  rejection?: 401 | 403
}

function makeCtx(options: CtxOptions = {}): {
  ctx: StreamRouteContext
  route(): { path: string; handler: (...args: never[]) => void }
} {
  let route: { path: string; handler: (...args: never[]) => void } | undefined
  const ctx: StreamRouteContext = {
    webServer: {
      registerUpgrade(value) {
        route = value as never
        return () => {}
      },
    },
    logger: { warn() {} },
  }
  if (options.hasConnection !== false) {
    ctx.connection = { requestRejection: () => options.rejection }
  }
  return { ctx, route: () => route as { path: string; handler: (...args: never[]) => void } }
}

interface ServiceState {
  ensure: number
  starts: number
  releases: number
  sink?: StreamSink
  touches: string[]
  keys: string[]
  texts: string[]
}

function makeService(): { state: ServiceState; service: PhoneStreamService } {
  const state: ServiceState = { ensure: 0, starts: 0, releases: 0, touches: [], keys: [], texts: [] }
  const service: PhoneStreamService = {
    async ensureRunning() {
      state.ensure += 1
    },
    async startStream(sink) {
      state.starts += 1
      state.sink = sink
      return async () => {
        state.releases += 1
      }
    },
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
  return { state, service }
}

function open(
  route: { handler: (...args: never[]) => void },
  socket: FakeSocket,
): void {
  route.handler(makeUpgradeRequest() as never, socket.asDuplex() as never, Buffer.alloc(0) as never)
}

async function send(socket: FakeSocket, value: unknown): Promise<void> {
  socket.emit('data', Buffer.from(textFrame(value)))
  await flush()
}

function closeCode(socket: FakeSocket): number | undefined {
  const frame = parseServerFrames(socket.bytes()).find((item) => item.opcode === 0x8)
  if (!frame || frame.payload.byteLength < 2) return undefined
  return ((frame.payload[0] as number) << 8) | (frame.payload[1] as number)
}

test('鉴权失败：requestRejection 结果映射为 HTTP 状态并拒绝升级', async () => {
  const { ctx, route } = makeCtx({ rejection: 403 })
  registerStreamRoute(ctx)
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  assert.match(socket.text(), /^HTTP\/1\.1 403 Forbidden/)
  assert.equal(socket.destroyed, true)
})

test('无 web carrier：503 E_NO_WEB', async () => {
  const { ctx, route } = makeCtx({ hasConnection: false })
  registerStreamRoute(ctx)
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  assert.match(socket.text(), /^HTTP\/1\.1 503/)
  assert.equal(socket.destroyed, true)
})

test('hello 成功：ensureRunning + startStream + ready/state + DPH1 视频帧', async () => {
  const { ctx, route } = makeCtx()
  const { state, service } = makeService()
  registerStreamRoute(ctx, { getService: () => service })
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  assert.match(socket.text(), /^HTTP\/1\.1 101/)

  await send(socket, { type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 }, visible: true })
  assert.equal(state.ensure, 1)
  assert.equal(state.starts, 1)

  const messages = textFrames(socket.bytes())
  assert.equal(messages.some((message) => message.type === 'ready'), true)
  assert.equal(messages.some((message) => message.type === 'state' && message.state === 'running'), true)

  const payload = new Uint8Array([0, 0, 0, 1, 0x67])
  state.sink?.video(payload)
  const frames = binaryFrames(socket.bytes())
  assert.equal(frames.length, 1)
  assert.deepEqual([...(frames[0]?.subarray(0, 4) ?? [])], [0x44, 0x50, 0x48, 0x31])
  assert.equal((frames[0]?.[4] as number) >>> 4, 0, 'configuration frameType=0')
  assert.deepEqual([...(frames[0]?.subarray(8) ?? [])], [...payload])

  const key = new Uint8Array([0, 0, 0, 1, 0x65])
  state.sink?.video(key, { keyframe: true, pts: 1_000_000n })
  const keyFrame = binaryFrames(socket.bytes()).at(-1)
  assert.equal(((keyFrame?.[4] as number) >>> 4), 1, 'keyframe frameType=1')
})

test('首条非 hello/重复 hello/非 JSON 均按 1008 关闭', async () => {
  const { ctx, route } = makeCtx()
  const { service } = makeService()

  const first = new FakeSocket()
  registerStreamRoute(ctx, { getService: () => service })
  open(route(), first)
  await flush()
  await send(first, { type: 'ping', t: 1 })
  assert.equal(textFrames(first.bytes()).some((message) => message.code === 'E_BAD_REQUEST'), true)
  assert.equal(closeCode(first), 1008)

  const again = new FakeSocket()
  registerStreamRoute(ctx, { getService: () => service })
  open(route(), again)
  await flush()
  await send(again, { type: 'hello', protocol: 1, viewport: { w: 10, h: 10 } })
  await send(again, { type: 'hello', protocol: 1, viewport: { w: 10, h: 10 } })
  assert.equal(textFrames(again.bytes()).some((message) => message.message === '重复 hello'), true)
  assert.equal(closeCode(again), 1008)

  const bad = new FakeSocket()
  registerStreamRoute(ctx, { getService: () => service })
  open(route(), bad)
  await flush()
  bad.emit('data', Buffer.from(clientFrame(0x1, new TextEncoder().encode('not json'))))
  await flush()
  assert.equal(closeCode(bad), 1008)
})

test('hello 后转发 touch/key/text，ping 回 pong', async () => {
  const { ctx, route } = makeCtx()
  const { state, service } = makeService()
  registerStreamRoute(ctx, { getService: () => service })
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  await send(socket, { type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 } })

  await send(socket, { type: 'touch', action: 'down', x: 10, y: 20 })
  await send(socket, { type: 'key', name: 'HOME' })
  await send(socket, { type: 'text', text: '中文输入' })
  await send(socket, { type: 'ping', t: 42 })

  assert.deepEqual(state.touches, ['down:10,20'])
  assert.deepEqual(state.keys, ['HOME'])
  assert.deepEqual(state.texts, ['中文输入'])
  assert.equal(textFrames(socket.bytes()).some((message) => message.type === 'pong' && message.t === 42), true)
})

test('visibility:false 释放 viewer，visibility:true 重新开流', async () => {
  const { ctx, route } = makeCtx()
  const { state, service } = makeService()
  registerStreamRoute(ctx, { getService: () => service })
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  await send(socket, { type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 } })
  assert.equal(state.starts, 1)

  await send(socket, { type: 'visibility', visible: false })
  assert.equal(state.releases, 1)
  assert.equal(textFrames(socket.bytes()).some((message) => message.state === 'paused'), true)

  await send(socket, { type: 'visibility', visible: true })
  assert.equal(state.starts, 2)
})

test('hello visible:false 不开流；socket 关闭触发 release', async () => {
  const { ctx, route } = makeCtx()
  const { state, service } = makeService()
  registerStreamRoute(ctx, { getService: () => service })
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  await send(socket, { type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 }, visible: false })
  assert.equal(state.starts, 0)

  await send(socket, { type: 'visibility', visible: true })
  assert.equal(state.starts, 1)
  socket.destroy()
  await flush()
  assert.equal(state.releases, 1)
})

test('新连接替换旧连接：旧连接收到 4001 关闭（issue #73 专用 code）', async () => {
  const { ctx, route } = makeCtx()
  const { state, service } = makeService()
  registerStreamRoute(ctx, { getService: () => service })

  const first = new FakeSocket()
  open(route(), first)
  await flush()
  await send(first, { type: 'hello', protocol: 1, viewport: { w: 1, h: 1 } })
  assert.equal(state.starts, 1)

  const second = new FakeSocket()
  open(route(), second)
  await flush()
  await send(second, { type: 'hello', protocol: 1, viewport: { w: 1, h: 1 } })
  assert.equal(closeCode(first), 4001)
  assert.equal(state.releases, 1)
  assert.equal(state.starts, 2)
})

test('客户端消息空闲超过 idleTimeoutMs → 1011 E_STREAM_IDLE（issue #73）', async () => {
  const { ctx, route } = makeCtx()
  const { service } = makeService()
  registerStreamRoute(ctx, { getService: () => service, idleTimeoutMs: 40 })
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  await send(socket, { type: 'hello', protocol: 1, viewport: { w: 1, h: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 120))
  await flush()
  assert.equal(closeCode(socket), 1011)
  const error = textFrames(socket.bytes()).find((message) => message.type === 'error')
  assert.equal(error?.code, 'E_STREAM_IDLE')
})

test('背压：delta 丢弃；configuration/keyframe 超限 → 1011 E_STREAM_BACKPRESSURE（issue #73）', async () => {
  const { ctx, route } = makeCtx()
  const { state, service } = makeService()
  registerStreamRoute(ctx, { getService: () => service, maxBufferedBytes: 8 })
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  await send(socket, { type: 'hello', protocol: 1, viewport: { w: 1, h: 1 } })
  assert.ok(state.sink)

  // 积压超限：delta 直接丢（不关闭）
  socket.writableLength = 16
  state.sink!.video(new Uint8Array([1, 2, 3]), { keyframe: false, pts: 1n })
  await flush()
  assert.equal(closeCode(socket), undefined)

  // keyframe 丢会黑屏 → 断开让客户端重连拿新 configuration/keyframe
  state.sink!.video(new Uint8Array([4, 5, 6]), { keyframe: true, pts: 2n })
  await flush()
  assert.equal(closeCode(socket), 1011)
  const error = textFrames(socket.bytes()).find((message) => message.type === 'error')
  assert.equal(error?.code, 'E_STREAM_BACKPRESSURE')
})

test('hello 超时按 1008 关闭', async () => {
  const { ctx, route } = makeCtx()
  const { state, service } = makeService()
  registerStreamRoute(ctx, { getService: () => service, helloTimeoutMs: 10 })
  const socket = new FakeSocket()
  open(route(), socket)
  await new Promise((resolve) => setTimeout(resolve, 30))
  await flush()
  assert.equal(closeCode(socket), 1008)
  assert.equal(state.starts, 0)
})

test('视频流异常：下发 error 文本并以 1011 关闭', async () => {
  const { ctx, route } = makeCtx()
  const { state, service } = makeService()
  registerStreamRoute(ctx, { getService: () => service })
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  await send(socket, { type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 } })

  state.sink?.error(new Error('scrcpy server 异常退出'))
  await flush()
  const messages = textFrames(socket.bytes())
  const error = messages.find((message) => message.type === 'error')
  assert.equal(error?.code, 'E_STREAM_START_FAILED')
  assert.equal(error?.retryable, true)
  assert.equal(closeCode(socket), 1011)
})

test('ready 携带 wm size 的 deviceWidth/deviceHeight，同时保留 viewport 回声', async () => {
  recordDeviceSize({ width: 1080, height: 2400 })
  try {
    const { ctx, route } = makeCtx()
    const { service } = makeService()
    registerStreamRoute(ctx, { getService: () => service })
    const socket = new FakeSocket()
    open(route(), socket)
    await flush()
    await send(socket, { type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 } })

    const ready = textFrames(socket.bytes()).find((message) => message.type === 'ready')
    assert.equal(ready?.deviceWidth, 1080)
    assert.equal(ready?.deviceHeight, 2400)
    assert.equal(ready?.width, 720, 'width/height 仍是 hello viewport（向后兼容）')
    assert.equal(ready?.height, 1280)
  } finally {
    recordDeviceSize(undefined)
  }
})

test('wm size 解析失败时 ready 省略 device 字段（客户端回退 viewport）', async () => {
  recordDeviceSize(undefined)
  const { ctx, route } = makeCtx()
  const { service } = makeService()
  registerStreamRoute(ctx, { getService: () => service })
  const socket = new FakeSocket()
  open(route(), socket)
  await flush()
  await send(socket, { type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 } })

  const ready = textFrames(socket.bytes()).find((message) => message.type === 'ready')
  assert.equal(ready !== undefined, true)
  assert.equal('deviceWidth' in (ready ?? {}), false)
  assert.equal('deviceHeight' in (ready ?? {}), false)
})