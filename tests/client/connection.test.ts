import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FRAME_MAGIC,
  NORMAL_CLOSURE,
  ReconnectBackoff,
  VisibilityGate,
  helloMessage,
  keyMessage,
  parseBinaryFrame,
  parseServerMessage,
  pingMessage,
  textMessage,
  touchMessage,
  visibilityMessage,
} from '../../src/client/connection.ts'
import type { VisibilitySources } from '../../src/client/connection.ts'
import type { SocketLike, StreamState } from '../../src/client/stream.ts'
import { PING_INTERVAL_MS, StreamClient, defaultStreamUrl } from '../../src/client/stream.ts'

const encoder = new TextEncoder()

/** Build one binary frame exactly as docs/protocol.md §2.2 freezes it. */
function frame(kind: number, pts: number, payload = 'h264'): ArrayBuffer {
  const bytes = new Uint8Array(8 + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, FRAME_MAGIC)
  view.setUint32(4, ((kind & 0x0f) << 28) | (pts & 0x0fffffff))
  bytes.set(encoder.encode(payload), 8)
  return bytes.buffer
}

test('parseBinaryFrame decodes configuration/keyframe/delta and pts', () => {
  const config = parseBinaryFrame(frame(0, 0, 'spspps'))
  assert.equal(config?.type, 'configuration')
  assert.equal(config?.keyframe, true)
  assert.equal(config?.ptsTicks, 0)
  assert.equal(new TextDecoder().decode(config?.payload), 'spspps')

  const key = parseBinaryFrame(frame(1, 90_000))
  assert.equal(key?.type, 'keyframe')
  assert.equal(key?.keyframe, true)
  // 90000 ticks = 1s = 1_000_000 µs.
  assert.equal(key?.ptsMicros, 1_000_000)

  const delta = parseBinaryFrame(frame(2, 45_000))
  assert.equal(delta?.type, 'delta')
  assert.equal(delta?.keyframe, false)
  assert.equal(delta?.ptsMicros, 500_000)
})

test('parseBinaryFrame rejects foreign or truncated messages', () => {
  assert.equal(parseBinaryFrame(new Uint8Array([1, 2, 3])), undefined)
  assert.equal(parseBinaryFrame('hello'), undefined)
  assert.equal(parseBinaryFrame({}), undefined)
  assert.equal(parseBinaryFrame(new Uint8Array(9)), undefined) // magic mismatch
  assert.equal(parseBinaryFrame(frame(0, 0, '')), undefined) // header only, no payload
})

test('parseBinaryFrame accepts a Uint8Array view with a byte offset', () => {
  const raw = new Uint8Array(frame(1, 1234, 'xyz'))
  const padded = new Uint8Array(raw.byteLength + 4)
  padded.set(raw, 4)
  const view = new Uint8Array(padded.buffer, 4)
  const parsed = parseBinaryFrame(view)
  assert.equal(parsed?.type, 'keyframe')
  assert.equal(parsed?.ptsTicks, 1234)
  assert.equal(new TextDecoder().decode(parsed?.payload), 'xyz')
})

test('client message builders match the frozen JSON shapes', () => {
  assert.deepEqual(JSON.parse(helloMessage({ w: 720, h: 1280 }, true)), {
    type: 'hello',
    protocol: 1,
    viewport: { w: 720, h: 1280 },
    visible: true,
  })
  assert.deepEqual(JSON.parse(touchMessage('move', 12.4, 40.6)), {
    type: 'touch',
    action: 'move',
    x: 12,
    y: 41,
  })
  assert.deepEqual(JSON.parse(keyMessage('BACK')), { type: 'key', name: 'BACK' })
  assert.deepEqual(JSON.parse(textMessage('你好')), { type: 'text', text: '你好' })
  assert.deepEqual(JSON.parse(visibilityMessage(false)), { type: 'visibility', visible: false })
  assert.deepEqual(JSON.parse(pingMessage(99)), { type: 'ping', t: 99 })
})

test('parseServerMessage accepts the four server frames and drops others', () => {
  assert.deepEqual(parseServerMessage('{"type":"ready","width":720,"height":1280,"codec":"h264","maxSize":720,"maxFps":15,"deviceWidth":1080,"deviceHeight":2400}'), {
    type: 'ready',
    width: 720,
    height: 1280,
    codec: 'h264',
    maxSize: 720,
    maxFps: 15,
    deviceWidth: 1080,
    deviceHeight: 2400,
  })
  assert.deepEqual(parseServerMessage('{"type":"state","state":"booting","bootMs":900}'), {
    type: 'state',
    state: 'booting',
    bootMs: 900,
  })
  assert.deepEqual(parseServerMessage('{"type":"pong","t":7}'), { type: 'pong', t: 7 })
  assert.deepEqual(parseServerMessage('{"type":"error","code":"E_AUTH","message":"no","retryable":false}'), {
    type: 'error',
    code: 'E_AUTH',
    message: 'no',
    retryable: false,
  })
  assert.equal(parseServerMessage('not json'), undefined)
  assert.equal(parseServerMessage('{"type":"unknown"}'), undefined)
  assert.equal(parseServerMessage('null'), undefined)
})

test('ReconnectBackoff doubles to the ceiling and applies symmetric jitter', () => {
  const plain = new ReconnectBackoff({ random: () => 0.5 })
  assert.deepEqual(
    [plain.nextDelay(), plain.nextDelay(), plain.nextDelay(), plain.nextDelay(), plain.nextDelay()],
    [500, 1000, 2000, 4000, 8000],
  )
  assert.equal(plain.nextDelay(), 8000)
  plain.reset()
  assert.equal(plain.nextDelay(), 500)

  const low = new ReconnectBackoff({ random: () => 0 })
  const high = new ReconnectBackoff({ random: () => 0.999999 })
  assert.equal(low.nextDelay(), 400) // 500 * 0.8
  assert.ok(high.nextDelay() <= 600 && high.nextDelay() >= 400)
})

test('VisibilityGate requires both document and intersection visibility', () => {
  const changes: boolean[] = []
  let setDocument: (visible: boolean) => void = () => {}
  let setIntersection: (visible: boolean) => void = () => {}
  const sources: VisibilitySources = {
    documentVisible: true,
    watchDocument: (listener) => {
      setDocument = listener
      return () => {}
    },
    watchIntersection: (listener) => {
      setIntersection = listener
      return () => {}
    },
  }
  const gate = new VisibilityGate(sources, (visible) => changes.push(visible))
  assert.equal(gate.visible, true)
  gate.start()
  setDocument(false)
  assert.equal(gate.visible, false)
  setIntersection(false)
  setDocument(true)
  assert.equal(gate.visible, false)
  setIntersection(true)
  assert.equal(gate.visible, true)
  assert.deepEqual(changes, [false, true])
  gate.stop()
  setDocument(false)
  assert.equal(gate.visible, true, 'stopped gate ignores late sources')
})

interface FakeTimer {
  id: number
  callback: () => void
  dueAt: number
  cancelled: boolean
}

/** Deterministic timers for the client state machine. */
class FakeClock {
  now = 0
  #nextId = 1
  timers: FakeTimer[] = []

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const timer: FakeTimer = { id: this.#nextId++, callback, dueAt: this.now + delayMs, cancelled: false }
    this.timers.push(timer)
    return timer
  }

  clearTimer = (handle: unknown): void => {
    const timer = handle as FakeTimer
    if (timer && typeof timer === 'object') timer.cancelled = true
  }

  advance(ms: number): void {
    this.now += ms
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= this.now)
        .sort((a, b) => a.dueAt - b.dueAt)[0]
      if (due === undefined) return
      due.cancelled = true
      due.callback()
    }
  }
}

/** One scripted WebSocket stand-in. */
class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = []

  static at(index: number): FakeSocket {
    const socket = FakeSocket.instances[index]
    if (socket === undefined) throw new Error(`missing fake socket #${index}`)
    return socket
  }
  readyState = 0
  binaryType = ''
  sent: string[] = []
  closedWith: number[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.readyState = 3
    this.closedWith.push(code ?? 0)
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  deliver(data: unknown): void {
    this.onmessage?.({ data })
  }

  shutdown(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

test('StreamClient: visible start handshakes, ready resets backoff, hide closes 1000', () => {
  FakeSocket.instances.length = 0
  const clock = new FakeClock()
  const states: StreamState[] = []
  const messages: unknown[] = []
  const client = new StreamClient({
    createSocket: (url) => new FakeSocket(url),
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    backoff: new ReconnectBackoff({ random: () => 0.5 }),
    onFrame: () => {},
    onMessage: (message) => messages.push(message),
    onState: (state) => states.push(state),
  })

  client.start(false)
  assert.deepEqual(FakeSocket.instances, [], 'hidden start must not connect')
  assert.equal(client.state, 'idle')

  client.setVisible(true)
  assert.equal(client.state, 'connecting')
  assert.equal(FakeSocket.instances.length, 1)

  const first = FakeSocket.at(0)
  assert.equal(first.url, defaultStreamUrl())
  first.open()
  assert.equal(client.state, 'open')
  assert.deepEqual(JSON.parse(first.sent[0]!), {
    type: 'hello',
    protocol: 1,
    viewport: { w: 720, h: 1280 },
    visible: true,
  })

  first.deliver('{"type":"ready","width":720,"height":1280,"codec":"h264","maxSize":720,"maxFps":15}')
  assert.equal(client.state, 'ready')
  assert.equal(messages.length, 1)

  client.setVisible(false)
  assert.equal(client.state, 'hidden')
  assert.deepEqual(first.closedWith, [NORMAL_CLOSURE])
  assert.equal(clock.timers.filter((timer) => !timer.cancelled).length, 0, 'no reconnect while hidden')
  assert.deepEqual(states, ['connecting', 'open', 'ready', 'hidden'])
})

test('StreamClient: reconnect backs off and retries after the delay', () => {
  FakeSocket.instances.length = 0
  const clock = new FakeClock()
  const client = new StreamClient({
    createSocket: (url) => new FakeSocket(url),
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    backoff: new ReconnectBackoff({ random: () => 0.5 }),
    onFrame: () => {},
    onMessage: () => {},
    onState: () => {},
  })
  client.start(true)
  const first = FakeSocket.at(0)
  first.open()
  first.shutdown()
  assert.equal(client.state, 'reconnecting')
  clock.advance(499)
  assert.equal(FakeSocket.instances.length, 1)
  clock.advance(1)
  assert.equal(FakeSocket.instances.length, 2)
  assert.equal(client.state, 'connecting')
})

test('StreamClient: sends control frames only while open and forwards binary frames', () => {
  FakeSocket.instances.length = 0
  const clock = new FakeClock()
  const frames: number[] = []
  const client = new StreamClient({
    createSocket: (url) => new FakeSocket(url),
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFrame: (parsed) => frames.push(parsed.ptsTicks),
    onMessage: () => {},
    onState: () => {},
  })
  client.sendTouch('down', 1, 2) // not connected yet: silent no-op
  client.start(true)
  const socket = FakeSocket.at(0)
  client.sendTouch('down', 1, 2)
  assert.equal(socket.sent.length, 0, 'socket not open yet')
  socket.open()
  client.sendTouch('down', 10, 20)
  client.sendKey('HOME')
  client.sendText('hello')
  assert.deepEqual(JSON.parse(socket.sent.at(-3)!), { type: 'touch', action: 'down', x: 10, y: 20 })
  assert.deepEqual(JSON.parse(socket.sent.at(-2)!), { type: 'key', name: 'HOME' })
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), { type: 'text', text: 'hello' })
  socket.deliver(frame(2, 450))
  assert.deepEqual(frames, [450])
})

test('StreamClient: heartbeat pings, and 60s of silence forces a reconnect', () => {
  FakeSocket.instances.length = 0
  const clock = new FakeClock()
  const client = new StreamClient({
    createSocket: (url) => new FakeSocket(url),
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    backoff: new ReconnectBackoff({ random: () => 0.5 }),
    onFrame: () => {},
    onMessage: () => {},
    onState: () => {},
  })
  client.start(true)
  const socket = FakeSocket.at(0)
  socket.open()
  clock.advance(PING_INTERVAL_MS)
  const pings = socket.sent.filter((raw) => raw.includes('"ping"'))
  assert.equal(pings.length, 1)
  clock.advance(PING_INTERVAL_MS * 2)
  assert.equal(socket.closedWith.at(-1), NORMAL_CLOSURE, 'half-open socket is closed')
  assert.equal(client.state, 'reconnecting')
  clock.advance(500)
  assert.equal(FakeSocket.instances.length, 2)
})

test('StreamClient: dispose stops reconnection for good', () => {
  FakeSocket.instances.length = 0
  const clock = new FakeClock()
  const client = new StreamClient({
    createSocket: (url) => new FakeSocket(url),
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFrame: () => {},
    onMessage: () => {},
    onState: () => {},
  })
  client.start(true)
  const socket = FakeSocket.at(0)
  socket.open()
  client.dispose()
  assert.equal(client.state, 'closed')
  clock.advance(60_000)
  assert.equal(FakeSocket.instances.length, 1)
})

test('StreamClient: auth close 1008 is terminal, reported and never retried', () => {
  FakeSocket.instances.length = 0
  const clock = new FakeClock()
  const errors: { code: string; retryable: boolean }[] = []
  const client = new StreamClient({
    createSocket: (url) => new FakeSocket(url),
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFrame: () => {},
    onMessage: () => {},
    onState: () => {},
    onError: (failure) => errors.push({ code: failure.code, retryable: failure.retryable }),
  })
  client.start(true)
  const socket = FakeSocket.at(0)
  socket.open()
  socket.shutdown(1008)
  assert.equal(client.state, 'closed')
  assert.deepEqual(errors, [{ code: 'E_AUTH', retryable: false }])
  clock.advance(60_000)
  assert.equal(FakeSocket.instances.length, 1, 'no reconnect after an auth rejection')
})

