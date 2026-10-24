import assert from 'node:assert/strict'
import { test } from 'node:test'

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

test('新连接替换旧连接：旧连接收到 1000 关闭', async () => {
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
  assert.equal(closeCode(first), 1000)
  assert.equal(state.releases, 1)
  assert.equal(state.starts, 2)
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
