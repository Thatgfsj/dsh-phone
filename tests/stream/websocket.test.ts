import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  computeAcceptKey,
  encodeServerFrame,
  FrameParser,
  WebSocketConnection,
  WebSocketHandshakeError,
} from '../../src/stream/websocket.ts'
import {
  clientFrame,
  FakeSocket,
  makeUpgradeRequest,
  parseServerFrames,
} from './helpers.ts'

test('Sec-WebSocket-Accept 使用 RFC 6455 官方向量', () => {
  assert.equal(
    computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  )
})

test('服务端帧编码：fin/opcode/长度（小包/16 位/64 位）', () => {
  const small = encodeServerFrame(0x1, new TextEncoder().encode('hi'))
  assert.equal(small[0], 0x81)
  assert.equal(small[1], 2)
  assert.equal(new TextDecoder().decode(small.subarray(2)), 'hi')

  const medium = encodeServerFrame(0x2, new Uint8Array(300))
  assert.equal(medium[0], 0x82)
  assert.equal(medium[1], 126)
  assert.equal(((medium[2] as number) << 8) | (medium[3] as number), 300)

  const large = encodeServerFrame(0x2, new Uint8Array(70_000))
  assert.equal(large[1], 127)
  assert.equal(large.byteLength, 10 + 70_000)
})

test('FrameParser 解析掩码帧并还原 payload', () => {
  const parser = new FrameParser()
  const frame = clientFrame(0x1, new TextEncoder().encode('你好'))
  const parsed = parser.push(frame)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.opcode, 0x1)
  assert.equal(parsed[0]?.fin, true)
  assert.equal(new TextDecoder().decode(parsed[0]?.payload), '你好')
})

test('FrameParser 支持 16 位长度与分块输入', () => {
  const payload = new Uint8Array(300).fill(7)
  const frame = clientFrame(0x2, payload)
  const parser = new FrameParser()
  assert.deepEqual(parser.push(frame.subarray(0, 3)), [])
  const parsed = parser.push(frame.subarray(3))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.payload.byteLength, 300)
})

test('FrameParser 拒绝未掩码客户端帧', () => {
  const frame = encodeServerFrame(0x1, new Uint8Array(1))
  assert.throws(() => new FrameParser().push(frame), /掩码/)
})

test('握手：101 + Accept 头 + 初始 ping', () => {
  const socket = new FakeSocket()
  const connection = WebSocketConnection.accept(makeUpgradeRequest(), socket.asDuplex())
  const handshake = socket.text()
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/)
  assert.match(handshake, /s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/)
  const frames = parseServerFrames(socket.bytes())
  assert.equal(frames.some((frame) => frame.opcode === 0x9), true, '握手后应有 ping')
  connection.close(1000)
})

test('handshake 校验失败抛 WebSocketHandshakeError', () => {
  assert.throws(
    () => WebSocketConnection.verify(makeUpgradeRequest({ upgrade: 'h2c' })),
    (error: unknown) => error instanceof WebSocketHandshakeError && error.status === 426,
  )
  assert.throws(
    () => WebSocketConnection.verify(makeUpgradeRequest({ 'sec-websocket-version': '8' })),
    (error: unknown) => error instanceof WebSocketHandshakeError,
  )
})

test('连接层：text/binary、分片重组、ping→pong、close 回调', () => {
  const socket = new FakeSocket()
  const connection = WebSocketConnection.accept(makeUpgradeRequest(), socket.asDuplex())
  const messages: { kind: string; text: string }[] = []
  let closed: { code: number; reason: string } | undefined
  connection.onMessage((kind, data) => messages.push({ kind, text: new TextDecoder().decode(data) }))
  connection.onClose((code, reason) => {
    closed = { code, reason }
  })

  socket.emit('data', Buffer.from(clientFrame(0x1, new TextEncoder().encode('完整'))))
  socket.emit('data', Buffer.from(clientFrame(0x1, new TextEncoder().encode('分'), false)))
  socket.emit('data', Buffer.from(clientFrame(0x0, new TextEncoder().encode('片'))))
  assert.deepEqual(messages, [
    { kind: 'text', text: '完整' },
    { kind: 'text', text: '分片' },
  ])

  socket.emit('data', Buffer.from(clientFrame(0x9, new Uint8Array([1, 2]))))
  const pong = parseServerFrames(socket.bytes()).filter((frame) => frame.opcode === 0xa)
  assert.equal(pong.length >= 1, true)
  assert.deepEqual([...(pong.at(-1)?.payload ?? [])], [1, 2])

  socket.emit('data', Buffer.from(clientFrame(0x8, new Uint8Array([0x03, 0xe8]))))
  assert.deepEqual(closed, { code: 1000, reason: '' })
})

test('服务端 close 写出 close 帧并触发 close 回调', () => {
  const socket = new FakeSocket()
  const connection = WebSocketConnection.accept(makeUpgradeRequest(), socket.asDuplex())
  let closed = false
  connection.onClose(() => {
    closed = true
  })
  connection.close(1001, 'bye')
  assert.equal(closed, true)
  const closeFrame = parseServerFrames(socket.bytes()).find((frame) => frame.opcode === 0x8)
  assert.equal(((closeFrame?.payload[0] as number) << 8) | (closeFrame?.payload[1] as number), 1001)
})
