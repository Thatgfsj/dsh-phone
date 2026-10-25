/**
 * 真实 /dsh-phone/stream WebSocket 验收（Node 24 全局 WebSocket + Cookie 头）。
 *
 * 注意：全局 WebSocket 的 { headers } 是 Node/undici 的非标准扩展（浏览器标准
 * 不支持自定义头）。本机实测 Node v24.21.0 会把 headers 带到 HTTP Upgrade，
 * 因此无需手写 RFC 6455 客户端；若未来 Node 移除该扩展，回退方案见
 * docs/verification.md（raw http.request Upgrade + 最小帧客户端）。
 */
import { assert, assertEqual } from './harness.mjs'
import { sleep } from './web-profile.mjs'

export const STREAM_PATH = '/dsh-phone/stream'
export const FRAME_MAGIC = Object.freeze([0x44, 0x50, 0x48, 0x31])
export const FRAME_TYPE_NAMES = { 0: 'configuration', 1: 'keyframe', 2: 'delta', 3: 'audio', 4: 'control' }

async function waitFor(check, timeoutMs, label, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await sleep(intervalMs)
  }
  throw new Error('等待超时（' + timeoutMs + 'ms）: ' + label)
}

/** 解析 DPH1 8 字节头；非法帧返回 null。 */
export function parseDph1(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null
  for (let index = 0; index < 4; index += 1) {
    if (bytes[index] !== FRAME_MAGIC[index]) return null
  }
  const meta = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0
  return {
    frameType: meta >>> 28,
    frameTypeName: FRAME_TYPE_NAMES[meta >>> 28] ?? 'unknown',
    pts: meta & 0x0fffffff,
    payloadBytes: bytes.length - 8,
    payloadPrefix: Array.from(bytes.subarray(8, 12)),
  }
}

/**
 * 连接 /dsh-phone/stream 并跑完整场景：hello → ready → 收帧 → 控制 → 关闭。
 * 返回可断言的统计；任何 error 文本帧/非法二进制帧都会记录（由调用方断言为空）。
 */
export async function runStreamScenario(options) {
  const { origin, cookie } = options
  const readyTimeoutMs = options.readyTimeoutMs ?? 180_000
  const frameWindowMs = options.frameWindowMs ?? 10_000
  assert(typeof WebSocket === 'function', '当前 Node 没有全局 WebSocket（需要 Node >= 22）')

  const url = origin.replace(/^http/, 'ws') + STREAM_PATH
  const ws = new WebSocket(url, { headers: { cookie } })
  ws.binaryType = 'arraybuffer'

  const texts = []
  const frames = []
  const socketErrors = []
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        texts.push(JSON.parse(event.data))
      } catch {
        socketErrors.push('非 JSON 文本帧')
      }
    } else if (event.data instanceof ArrayBuffer) {
      frames.push(new Uint8Array(event.data))
    } else {
      socketErrors.push('未知消息类型: ' + Object.prototype.toString.call(event.data))
    }
  })
  ws.addEventListener('error', () => socketErrors.push('WebSocket error 事件'))

  await waitFor(() => ws.readyState === WebSocket.OPEN, 20_000, 'WS 握手（带 Cookie 头）')
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 }, visible: true }))
  const ready = await waitFor(
    () => {
      const error = texts.find((message) => message.type === 'error')
      if (error) throw new Error('WS 在 ready 前收到 error 帧: ' + JSON.stringify(error))
      return texts.find((message) => message.type === 'ready')
    },
    readyTimeoutMs,
    'ready 文本帧（含冷启动/首次下载 scrcpy-server）；已收到文本类型=' + JSON.stringify(texts.map((m) => m.type)),
  )

  const startedAt = Date.now()
  await sleep(frameWindowMs)
  const observedMs = Date.now() - startedAt
  const parsed = frames.map(parseDph1)
  const invalidFrames = parsed.filter((frame) => frame === null).length
  const validFrames = parsed.filter((frame) => frame !== null)
  const countType = (type) => validFrames.filter((frame) => frame.frameType === type).length

  // 控制通道：key / touch / 中文文本，全部走 scrcpy control socket。
  ws.send(JSON.stringify({ type: 'key', name: 'HOME' }))
  ws.send(JSON.stringify({ type: 'touch', action: 'down', x: 360, y: 640 }))
  ws.send(JSON.stringify({ type: 'touch', action: 'up', x: 360, y: 640 }))
  ws.send(JSON.stringify({ type: 'text', text: '你好 e2e' }))
  await sleep(1200)

  const errorTexts = texts.filter((message) => message.type === 'error')
  ws.close(1000, 'e2e done')
  await waitFor(
    () => ws.readyState === WebSocket.CLOSED,
    10_000,
    'WS 关闭',
  ).catch(() => undefined)

  return {
    url,
    ready,
    textTypes: texts.map((message) => message.type),
    stateMessages: texts.filter((message) => message.type === 'state'),
    errorTexts,
    socketErrors,
    frameCount: validFrames.length,
    invalidFrames,
    configurationFrames: countType(0),
    keyFrames: countType(1),
    deltaFrames: countType(2),
    observedMs,
    approxFps: validFrames.length / (observedMs / 1000),
    sampleFrames: validFrames.slice(0, 3),
    controlSent: ['key:HOME', 'touch:down/up(360,640)', 'text:你好 e2e'],
    controlErrorCount: errorTexts.length,
  }
}

/**
 * 只探测 WS 握手/首个 ready-or-error：用于真实环境里 Host 实现可能有缺陷时
 * 仍能拿到结构化结果（不抛错）。返回 { ok, ready?, error?, texts, socketErrors }。
 */
export async function probeStreamHandshake(options) {
  const { origin, cookie } = options
  const timeoutMs = options.timeoutMs ?? 30_000
  const url = origin.replace(/^http/, 'ws') + STREAM_PATH
  const ws = new WebSocket(url, { headers: { cookie } })
  ws.binaryType = 'arraybuffer'
  const texts = []
  const socketErrors = []
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    try {
      texts.push(JSON.parse(event.data))
    } catch {
      socketErrors.push('非 JSON 文本帧')
    }
  })
  ws.addEventListener('error', () => socketErrors.push('WebSocket error 事件'))
  const close = () => {
    try {
      ws.close(1000, 'probe done')
    } catch {
      // 已关闭
    }
  }
  await waitFor(() => ws.readyState === WebSocket.OPEN, 15_000, 'WS 握手（probe）')
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, viewport: { w: 720, h: 1280 }, visible: true }))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const error = texts.find((message) => message.type === 'error')
    if (error) {
      close()
      return { ok: false, error, texts, socketErrors }
    }
    const ready = texts.find((message) => message.type === 'ready')
    if (ready) {
      close()
      return { ok: true, ready, texts, socketErrors }
    }
    if (ws.readyState === WebSocket.CLOSED) {
      return { ok: false, closed: true, texts, socketErrors }
    }
    await sleep(100)
  }
  close()
  return { ok: false, timeout: true, texts, socketErrors }
}
