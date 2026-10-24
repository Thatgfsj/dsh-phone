/**
 * Live WebSocket session for the phone stream (docs/protocol.md §2.1/§2.4).
 *
 * Split from connection.ts (wire format + visibility gate) so each file stays
 * small; this half owns the socket lifecycle, reconnect backoff and heartbeat.
 */
import type { ParsedVideoFrame, ServerMessage, KeyName, TouchAction, Viewport } from './connection.ts'
import {
  NORMAL_CLOSURE,
  ReconnectBackoff,
  STREAM_PATH,
  helloMessage,
  keyMessage,
  parseBinaryFrame,
  parseServerMessage,
  pingMessage,
  textMessage,
  touchMessage,
} from './connection.ts'

export type StreamState = 'idle' | 'connecting' | 'open' | 'ready' | 'reconnecting' | 'closed' | 'hidden'

/** Minimal WebSocket face used by StreamClient (DOM WebSocket satisfies it). */
export interface SocketLike {
  readyState: number
  binaryType: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** Interval between client heartbeats (docs/protocol.md §2.4). */
export const PING_INTERVAL_MS = 20_000
/** Silence after which a half-open socket is torn down and re-established. */
export const PONG_TIMEOUT_MS = 60_000

export interface StreamClientOptions {
  onFrame: (frame: ParsedVideoFrame) => void
  onMessage: (message: ServerMessage) => void
  onState: (state: StreamState) => void
  /** Non-retryable terminal failures (e.g. the auth close code 1008). */
  onError?: (error: { code: string; message: string; retryable: boolean }) => void
  /** Socket factory; defaults to the browser WebSocket. */
  createSocket?: (url: string) => SocketLike
  /** Override for tests / alternate origins. */
  url?: string
  viewport?: () => Viewport
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  backoff?: ReconnectBackoff
}

/** Same-origin websocket URL for the stream. */
export function defaultStreamUrl(): string {
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = typeof location !== 'undefined' ? location.host : '127.0.0.1'
  return `${protocol}//${host}${STREAM_PATH}`
}

/**
 * Stream connection state machine: connect on visibility, detach on hide,
 * exponential backoff while visible, heartbeat-driven half-open detection.
 */
export class StreamClient {
  #state: StreamState = 'idle'
  #visible = false
  #disposed = false
  #socket: SocketLike | undefined
  #heartbeat: unknown
  #retry: unknown
  #lastMessageAt = 0
  readonly #options: StreamClientOptions
  readonly #backoff: ReconnectBackoff
  readonly #now: () => number
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimer: (handle: unknown) => void

  constructor(options: StreamClientOptions) {
    this.#options = options
    this.#backoff = options.backoff ?? new ReconnectBackoff()
    this.#now = options.now ?? (() => Date.now())
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get state(): StreamState {
    return this.#state
  }

  get visible(): boolean {
    return this.#visible
  }

  /** Start the client in the given visibility state; hidden starts idle. */
  start(visible: boolean): void {
    this.#disposed = false
    this.setVisible(visible)
  }

  /** Gate the stream on panel visibility; hiding closes the socket immediately. */
  setVisible(visible: boolean): void {
    if (this.#disposed || this.#visible === visible) return
    this.#visible = visible
    if (!visible) {
      this.#clearTimers()
      this.#closeSocket(NORMAL_CLOSURE)
      this.#setState('hidden')
      return
    }
    this.#backoff.reset()
    this.#connect()
  }

  /** Manual "reconnect" button: drop the current socket and retry immediately. */
  reconnect(): void {
    if (this.#disposed || !this.#visible) return
    this.#backoff.reset()
    this.#clearTimers()
    this.#closeSocket(NORMAL_CLOSURE)
    this.#connect()
  }

  /** Stop for good; no reconnect is scheduled. */
  dispose(): void {
    this.#disposed = true
    this.#visible = false
    this.#clearTimers()
    this.#closeSocket(NORMAL_CLOSURE)
    this.#setState('closed')
  }

  sendTouch(action: TouchAction, x: number, y: number): void {
    this.#send(touchMessage(action, x, y))
  }

  sendKey(name: KeyName): void {
    this.#send(keyMessage(name))
  }

  sendText(text: string): void {
    this.#send(textMessage(text))
  }

  #send(data: string): void {
    const socket = this.#socket
    if (socket === undefined || socket.readyState !== 1) return
    socket.send(data)
  }

  #connect(): void {
    if (this.#socket !== undefined || this.#disposed || !this.#visible) return
    this.#setState('connecting')
    const url = this.#options.url ?? defaultStreamUrl()
    let socket: SocketLike
    try {
      socket = this.#options.createSocket?.(url) ?? (new WebSocket(url) as unknown as SocketLike)
    } catch {
      this.#scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.#socket = socket
    socket.onopen = () => {
      if (this.#socket !== socket) return
      this.#lastMessageAt = this.#now()
      socket.send(helloMessage(this.#options.viewport?.() ?? { w: 720, h: 1280 }, this.#visible))
      this.#setState('open')
      this.#startHeartbeat()
    }
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return
      this.#lastMessageAt = this.#now()
      const data: unknown = event.data
      if (typeof data === 'string') {
        const message = parseServerMessage(data)
        if (message === undefined) return
        if (message.type === 'ready') {
          this.#backoff.reset()
          this.#setState('ready')
        }
        if (message.type === 'error' && !message.retryable) this.#setState('closed')
        this.#options.onMessage(message)
        return
      }
      const frame = parseBinaryFrame(data)
      if (frame !== undefined) this.#options.onFrame(frame)
    }
    socket.onerror = () => {
      /* a close event follows; backoff is handled there */
    }
    socket.onclose = (event) => {
      if (this.#socket === socket) this.#socket = undefined
      this.#clearTimerHandle(this.#heartbeat)
      this.#heartbeat = undefined
      if (this.#disposed) {
        this.#setState('closed')
        return
      }
      if (event?.code === 1008) {
        // docs/protocol.md §3: E_AUTH/E_ORIGIN are not retryable.
        this.#setState('closed')
        this.#options.onError?.({ code: 'E_AUTH', message: 'unauthorized', retryable: false })
        return
      }
      if (!this.#visible) {
        this.#setState('hidden')
        return
      }
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect(): void {
    if (this.#disposed || !this.#visible) return
    this.#socket = undefined
    this.#setState('reconnecting')
    const delay = this.#backoff.nextDelay()
    this.#retry = this.#setTimer(() => {
      this.#retry = undefined
      this.#connect()
    }, delay)
  }

  #startHeartbeat(): void {
    this.#clearTimerHandle(this.#heartbeat)
    this.#heartbeat = this.#setTimer(() => {
      if (this.#disposed) return
      if (this.#now() - this.#lastMessageAt >= PONG_TIMEOUT_MS) {
        this.#teardownHalfOpen()
        return
      }
      this.#send(pingMessage(this.#now()))
      this.#startHeartbeat()
    }, PING_INTERVAL_MS)
  }

  #teardownHalfOpen(): void {
    this.#clearTimerHandle(this.#heartbeat)
    this.#heartbeat = undefined
    this.#closeSocket(NORMAL_CLOSURE)
    this.#scheduleReconnect()
  }

  #clearTimerHandle(handle: unknown): void {
    if (handle !== undefined) this.#clearTimer(handle)
  }

  #clearTimers(): void {
    this.#clearTimerHandle(this.#heartbeat)
    this.#heartbeat = undefined
    this.#clearTimerHandle(this.#retry)
    this.#retry = undefined
  }

  #closeSocket(code: number): void {
    const socket = this.#socket
    this.#socket = undefined
    if (socket === undefined) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close(code)
    } catch {
      /* already closed */
    }
  }

  #setState(state: StreamState): void {
    if (this.#state === state) return
    this.#state = state
    this.#options.onState(state)
  }
}
