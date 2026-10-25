/**
 * WebSocket transport for the phone video stream (docs/protocol.md §2).
 *
 * DOM-light: socket/timers/clock/randomness are injectable, so the reconnect
 * and visibility state machines are unit-tested; DOM wiring lives in panel.ts.
 *
 * Frozen by docs/protocol.md: same-origin `/dsh-phone/stream`, no token;
 * the first client frame is `hello`; the server sends JSON text plus binary
 * frames with an 8-byte header: ASCII `DPH1` + u32 meta (4 bits type
 * 0 config/1 key/2 delta/3 audio/4 control, 28 bits pts @90 kHz).
 */

/** Same-origin upgrade path. */
export const STREAM_PATH = '/dsh-phone/stream'
/** ASCII "DPH1". */
export const FRAME_MAGIC = 0x44504831
/** Magic (4 bytes) + meta (u32 big-endian). */
export const FRAME_HEADER_BYTES = 8
/** WebSocket close code used when the panel stops being visible. */
export const NORMAL_CLOSURE = 1000
/** Server uses this code when a newer page replaced this stream connection (issue #73). */
export const STREAM_REPLACED_CLOSURE = 4001

export type VideoFrameKind = 'configuration' | 'keyframe' | 'delta' | 'audio' | 'control'

const FRAME_KINDS: readonly VideoFrameKind[] = [
  'configuration',
  'keyframe',
  'delta',
  'audio',
  'control',
]

export interface ParsedVideoFrame {
  readonly type: VideoFrameKind
  /** True for keyframes and the configuration packet. */
  readonly keyframe: boolean
  /** Raw 28-bit pts in 1/90000 s ticks. */
  readonly ptsTicks: number
  /** pts converted to microseconds for `EncodedVideoChunk.timestamp`. */
  readonly ptsMicros: number
  /** H.264 Annex-B payload (never mutated; points into the source buffer). */
  readonly payload: Uint8Array
}

export interface ReadyMessage {
  type: 'ready'
  /** Visible video size (the hello viewport). */
  width: number
  height: number
  /** Optional real device framebuffer size, used for touch coordinates. */
  deviceWidth?: number
  deviceHeight?: number
  codec: string
  maxSize: number
  maxFps: number
}

export interface StateMessage {
  type: 'state'
  state: 'stopped' | 'booting' | 'running' | 'paused'
  bootMs?: number
}

export interface PongMessage {
  type: 'pong'
  t: number
}

export interface ErrorMessage {
  type: 'error'
  code: string
  message: string
  retryable: boolean
}

export type ServerMessage = ReadyMessage | StateMessage | PongMessage | ErrorMessage

export type TouchAction = 'down' | 'move' | 'up'

export type KeyName =
  | 'HOME'
  | 'BACK'
  | 'RECENTS'
  | 'ENTER'
  | 'DEL'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'
  | 'POWER'

function bytesOf(input: ArrayBuffer | ArrayBufferView): Uint8Array | undefined {
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  return undefined
}

/**
 * Decode one binary WebSocket message (docs/protocol.md §2.2).
 * @param input - message payload as delivered by the socket.
 * @returns the frame, or `undefined` for a malformed / foreign message.
 */
export function parseBinaryFrame(input: ArrayBuffer | ArrayBufferView | unknown): ParsedVideoFrame | undefined {
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) return undefined
  const bytes = bytesOf(input as ArrayBuffer | ArrayBufferView)
  if (bytes === undefined || bytes.byteLength <= FRAME_HEADER_BYTES) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== FRAME_MAGIC) return undefined
  const meta = view.getUint32(4)
  const kind = FRAME_KINDS[(meta >>> 28) & 0x0f]
  if (kind === undefined) return undefined
  const ptsTicks = meta & 0x0fffffff
  return {
    type: kind,
    keyframe: kind === 'keyframe' || kind === 'configuration',
    ptsTicks,
    // docs/protocol.md §2.2: µs = round(ticks * 1000 / 90).
    ptsMicros: Math.round((ptsTicks * 1000) / 90),
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  }
}

/** Serialize the mandatory first client frame. */
export function helloMessage(viewport: { w: number; h: number }, visible: boolean): string {
  return JSON.stringify({ type: 'hello', protocol: 1, viewport, visible })
}

/** Serialize a touch event in device pixel coordinates. */
export function touchMessage(action: TouchAction, x: number, y: number): string {
  return JSON.stringify({ type: 'touch', action, x: Math.round(x), y: Math.round(y) })
}

export function keyMessage(name: KeyName): string {
  return JSON.stringify({ type: 'key', name })
}

export function textMessage(text: string): string {
  return JSON.stringify({ type: 'text', text })
}

export function visibilityMessage(visible: boolean): string {
  return JSON.stringify({ type: 'visibility', visible })
}

export function pingMessage(t: number): string {
  return JSON.stringify({ type: 'ping', t })
}

/**
 * Parse one server text frame.
 * @param raw - the text message.
 * @returns the typed message, or `undefined` when it is not a protocol frame.
 */
export function parseServerMessage(raw: string): ServerMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'ready':
      return {
        type: 'ready',
        width: Number(record.width) || 0,
        height: Number(record.height) || 0,
        codec: typeof record.codec === 'string' ? record.codec : 'h264',
        deviceWidth: record.deviceWidth === undefined ? undefined : Number(record.deviceWidth),
        deviceHeight: record.deviceHeight === undefined ? undefined : Number(record.deviceHeight),
        maxSize: Number(record.maxSize) || 0,
        maxFps: Number(record.maxFps) || 0,
      }
    case 'state':
      return {
        type: 'state',
        state: typeof record.state === 'string' ? (record.state as StateMessage['state']) : 'stopped',
        bootMs: record.bootMs === undefined ? undefined : Number(record.bootMs),
      }
    case 'pong':
      return { type: 'pong', t: Number(record.t) || 0 }
    case 'error':
      return {
        type: 'error',
        code: typeof record.code === 'string' ? record.code : 'E_UNKNOWN',
        message: typeof record.message === 'string' ? record.message : 'stream error',
        retryable: record.retryable === true,
      }
    default:
      return undefined
  }
}

export interface BackoffOptions {
  /** First retry delay; doubles per attempt. */
  baseMs?: number
  /** Delay ceiling before jitter. */
  maxMs?: number
  /** Symmetric jitter ratio (0.2 = ±20%). */
  jitter?: number
  /** Injectable randomness in [0, 1). */
  random?: () => number
}

/** Exponential reconnect delay: `min(base * 2^n, max)` with ±jitter. */
export class ReconnectBackoff {
  #attempt = 0
  readonly #baseMs: number
  readonly #maxMs: number
  readonly #jitter: number
  readonly #random: () => number

  constructor(options: BackoffOptions = {}) {
    this.#baseMs = options.baseMs ?? 500
    this.#maxMs = options.maxMs ?? 8000
    this.#jitter = options.jitter ?? 0.2
    this.#random = options.random ?? Math.random
  }

  /** Completed failed attempts since the last reset. */
  get attempt(): number {
    return this.#attempt
  }

  /** Advance one attempt and return the delay to wait before reconnecting. */
  nextDelay(): number {
    const raw = Math.min(this.#baseMs * 2 ** this.#attempt, this.#maxMs)
    this.#attempt += 1
    const offset = raw * this.#jitter * (this.#random() * 2 - 1)
    return Math.max(0, Math.round(raw + offset))
  }

  /** Called after a successful `ready` so the next outage starts at baseMs. */
  reset(): void {
    this.#attempt = 0
  }
}

export interface VisibilitySources {
  /** Current document visibility at start time. */
  documentVisible: boolean
  /** Subscribe to `visibilitychange`; returns an unsubscribe callback. */
  watchDocument: (listener: (visible: boolean) => void) => () => void
  /** Subscribe to IntersectionObserver changes; returns an unsubscribe callback. */
  watchIntersection: (listener: (visible: boolean) => void) => () => void
}

/**
 * Dual visibility gate: the panel streams only while the document is visible
 * AND the panel body is inside the viewport (docs/protocol.md §2.4).
 */
export class VisibilityGate {
  #documentVisible: boolean
  #intersecting = true
  #visible: boolean
  #started = false
  readonly #sources: VisibilitySources
  readonly #onChange: (visible: boolean) => void

  constructor(sources: VisibilitySources, onChange: (visible: boolean) => void) {
    this.#sources = sources
    this.#onChange = onChange
    this.#documentVisible = sources.documentVisible
    this.#visible = sources.documentVisible
  }

  get visible(): boolean {
    return this.#visible
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#unsubscribers.push(this.#sources.watchDocument((visible) => {
      if (!this.#started) return
      this.#documentVisible = visible
      this.#recompute()
    }))
    this.#unsubscribers.push(this.#sources.watchIntersection((visible) => {
      if (!this.#started) return
      this.#intersecting = visible
      this.#recompute()
    }))
    this.#recompute()
  }

  stop(): void {
    this.#started = false
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe()
  }

  #unsubscribers: (() => void)[] = []

  #recompute(): void {
    const next = this.#documentVisible && this.#intersecting
    if (next === this.#visible) return
    this.#visible = next
    this.#onChange(next)
  }
}