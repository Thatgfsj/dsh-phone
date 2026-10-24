/**
 * WS 路由 `/dsh-phone/stream`（docs/protocol.md §2，冻结）。
 *
 * 职责：upgrade 鉴权 → hello 校验 → ensureRunning/startStream（viewer 计数由
 * PhoneService/StreamSession 负责）→ 8 字节 DPH1 头 + H.264 透传 → 控制消息转发。
 * Host 不解码、不转码、不合并/拆分 scrcpy packet。
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { encodeFrame, FRAME_TYPE, microsToTicks, StreamClock } from './frames.ts'
import { DEFAULT_STREAM_OPTIONS } from './types.ts'
import type { PhoneStreamService, StreamOptions, StreamSink, TouchAction } from './types.ts'
import { WebSocketConnection, WebSocketHandshakeError } from './websocket.ts'
import { parseClientMessage } from './ws-messages.ts'

export const STREAM_PATH = '/dsh-phone/stream'
/** hello 必须在该时间内到达（docs/protocol.md：首条必须是 hello）。 */
export const DEFAULT_HELLO_TIMEOUT_MS = 5_000
/** 后端 socket 积压超过该值时丢弃 delta 帧，等下一个 keyframe（不拆包、不合包）。 */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export interface StreamLogger {
  warn(message: string): void
  error?(message: string): void
}

/** 路由上下文的最小结构（ctx.webServer / ctx.connection 的冻结用法）。 */
export interface StreamRouteContext {
  webServer: {
    registerUpgrade(route: {
      path: string
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
    }): () => void
  }
  connection?: {
    requestRejection(request: IncomingMessage): 401 | 403 | undefined
  } | undefined
  logger?: StreamLogger
  get?(key: string): unknown
}

export interface StreamRouteDeps {
  /** PhoneService 解析（host 装配时传入；缺省从 ctx.get 现有服务键探测）。 */
  getService?: () => PhoneStreamService | Promise<PhoneStreamService>
  /** 当前 config.stream（ready 消息展示用）。 */
  getStreamOptions?: () => StreamOptions
  helloTimeoutMs?: number
  maxBufferedBytes?: number
  logger?: StreamLogger
}

/** 缺省服务键候选（host 尚未冻结服务键时依次尝试）。 */
const SERVICE_KEYS = ['dshPhoneService', 'phoneService', 'dshPhone'] as const

/** 注册 upgrade 路由，返回 disposer（放进 ctx.effect 随插件卸载回收）。 */
export function registerStreamRoute(ctx: StreamRouteContext, deps: StreamRouteDeps = {}): () => void {
  const logger = deps.logger ?? ctx.logger
  let active: StreamConnection | undefined

  const disposeUpgrade = ctx.webServer.registerUpgrade({
    path: STREAM_PATH,
    handler: (req, socket, head) => {
      void handleUpgrade(req, socket, head).catch((error: unknown) => {
        logger?.warn('[dsh-phone] stream upgrade 失败: ' + errorMessage(error))
        destroyQuietly(socket)
      })
    },
  })

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!ctx.connection) return rejectUpgrade(socket, 503, 'no web carrier')
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) return rejectUpgrade(socket, rejection, 'rejected')
    try {
      WebSocketConnection.verify(req)
    } catch (error) {
      if (error instanceof WebSocketHandshakeError) return rejectUpgrade(socket, error.status, error.message)
      throw error
    }

    const service = await resolveService()
    if (!service) return rejectUpgrade(socket, 503, 'phone service unavailable')

    const previous = active
    active = undefined
    previous?.close(1000, 'replaced')

    const connection = WebSocketConnection.accept(req, socket, head)
    const client = new StreamConnection(connection, {
      service,
      options: deps.getStreamOptions?.() ?? DEFAULT_STREAM_OPTIONS,
      helloTimeoutMs: deps.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
      maxBufferedBytes: deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      logger,
      onClosed: () => {
        if (active === client) active = undefined
      },
    })
    active = client
    client.start()
  }

  async function resolveService(): Promise<PhoneStreamService | undefined> {
    if (deps.getService) return deps.getService()
    for (const key of SERVICE_KEYS) {
      const candidate = ctx.get?.(key)
      if (candidate) return candidate as PhoneStreamService
    }
    return undefined
  }

  return () => {
    const current = active
    active = undefined
    current?.close(1000, 'disposed')
    disposeUpgrade()
  }
}

interface StreamConnectionOptions {
  service: PhoneStreamService
  options: StreamOptions
  helloTimeoutMs: number
  maxBufferedBytes: number
  logger?: StreamLogger
  onClosed: () => void
}

type OutboundMessage = Record<string, unknown>

class StreamConnection {
  #ws: WebSocketConnection
  #options: StreamConnectionOptions
  #clock = new StreamClock()
  #helloDone = false
  #viewport = { w: 0, h: 0 }
  #release: (() => Promise<void>) | undefined
  #starting: Promise<void> | undefined
  #helloTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false

  constructor(ws: WebSocketConnection, options: StreamConnectionOptions) {
    this.#ws = ws
    this.#options = options
  }

  start(): void {
    this.#ws.onMessage((kind, data) => {
      this.#onMessage(kind, data).catch((error: unknown) => {
        this.#logWarn('消息处理失败: ' + errorMessage(error))
      })
    })
    this.#ws.onClose(() => {
      void this.#shutdown()
    })
    this.#helloTimer = setTimeout(() => {
      if (!this.#helloDone) this.#fail(1008, 'E_BAD_REQUEST', 'hello 超时')
    }, this.#options.helloTimeoutMs)
    this.#helloTimer.unref?.()
  }

  close(code: number, reason: string): void {
    if (this.#closed) return
    this.#ws.close(code, reason)
  }

  async #onMessage(kind: 'text' | 'binary', data: Uint8Array): Promise<void> {
    if (this.#closed) return
    if (kind === 'binary') {
      this.#fail(1002, 'E_BAD_REQUEST', '客户端不得发送 binary 消息')
      return
    }
    const parsed = parseClientMessage(new TextDecoder().decode(data))
    if (!parsed.ok) {
      this.#sendError('E_BAD_REQUEST', parsed.reason, false)
      this.#fail(1008, 'E_BAD_REQUEST', parsed.reason)
      return
    }
    const message = parsed.message
    if (!this.#helloDone) {
      if (message.kind !== 'hello') {
        this.#fail(1008, 'E_BAD_REQUEST', '首条消息必须是 hello')
        return
      }
      await this.#onHello(message)
      return
    }
    switch (message.kind) {
      case 'hello':
        this.#fail(1008, 'E_BAD_REQUEST', '重复 hello')
        return
      case 'ping':
        this.#send({ type: 'pong', t: message.t })
        return
      case 'visibility':
        await this.#onVisibility(message.visible)
        return
      case 'touch':
        await this.#forward(() => this.#options.service.touch(message.action, message.x, message.y))
        return
      case 'key':
        await this.#forward(() => this.#options.service.key(message.name))
        return
      case 'text':
        await this.#forward(() => this.#options.service.inputText(message.text))
        return
    }
  }

  async #onHello(message: { viewport: { w: number; h: number }; visible: boolean }): Promise<void> {
    this.#helloDone = true
    if (this.#helloTimer) clearTimeout(this.#helloTimer)
    this.#helloTimer = undefined
    this.#viewport = { ...message.viewport }
    if (message.visible) {
      await this.#attach()
    } else {
      this.#send({ type: 'state', state: 'paused' })
    }
  }

  async #onVisibility(visible: boolean): Promise<void> {
    if (visible) {
      await this.#attach()
    } else {
      await this.#detach()
      this.#send({ type: 'state', state: 'paused' })
    }
  }

  async #attach(): Promise<void> {
    if (this.#closed || this.#release || this.#starting) return
    this.#send({ type: 'state', state: 'booting' })
    this.#starting = (async () => {
      await this.#options.service.ensureRunning()
      if (this.#closed) return
      const release = await this.#options.service.startStream(this.#sink())
      if (this.#closed) {
        await release().catch(() => {})
        return
      }
      this.#release = release
      this.#send({
        type: 'ready',
        width: this.#viewport.w,
        height: this.#viewport.h,
        codec: 'h264',
        maxSize: this.#options.options.maxSize,
        maxFps: this.#options.options.maxFps,
      })
      this.#send({ type: 'state', state: 'running' })
    })()
      .catch((error: unknown) => this.#streamFailed(error))
      .finally(() => {
        this.#starting = undefined
      })
    await this.#starting
  }

  async #detach(): Promise<void> {
    const release = this.#release
    this.#release = undefined
    if (release) await release().catch(() => {})
  }

  async #shutdown(): Promise<void> {
    this.#closed = true
    if (this.#helloTimer) clearTimeout(this.#helloTimer)
    this.#helloTimer = undefined
    await this.#detach()
    this.#options.onClosed()
  }

  #sink(): StreamSink {
    return {
      video: (chunk, meta) => {
        if (this.#closed) return
        const type = meta === undefined
          ? FRAME_TYPE.configuration
          : meta.keyframe
            ? FRAME_TYPE.keyframe
            : FRAME_TYPE.delta
        if (type === FRAME_TYPE.delta && this.#ws.bufferedBytes > this.#options.maxBufferedBytes) {
          return // 背压：丢弃 delta，客户端等下一个 keyframe（不拆包）
        }
        const pts = meta?.pts !== undefined ? microsToTicks(meta.pts) : this.#clock.next()
        this.#ws.sendBinary(encodeFrame(type, pts, chunk))
      },
      error: (error) => this.#streamFailed(error),
    }
  }

  #streamFailed(error: unknown): void {
    const reason = errorMessage(error)
    this.#logWarn('视频流异常: ' + reason)
    this.#sendError('E_STREAM_START_FAILED', reason, true)
    void this.#detach()
    this.#fail(1011, 'E_STREAM_START_FAILED', reason)
  }

  #forward(action: () => Promise<void>): Promise<void> {
    return action().catch((error: unknown) => {
      this.#sendError('E_DEVICE_COMMAND', errorMessage(error), true)
    })
  }

  #sendError(code: string, message: string, retryable: boolean): void {
    this.#send({ type: 'error', code, message, retryable })
  }

  #send(message: OutboundMessage): void {
    if (this.#closed) return
    this.#ws.sendText(JSON.stringify(message))
  }

  #fail(code: number, errorCode: string, reason: string): void {
    if (this.#closed) return
    this.#sendError(errorCode, reason, false)
    this.#closed = true
    this.#ws.close(code, reason)
  }

  #logWarn(message: string): void {
    this.#options.logger?.warn('[dsh-phone] ' + message)
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  426: 'Upgrade Required',
  503: 'Service Unavailable',
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const text = STATUS_TEXT[status] ?? 'Error'
  socket.write(
    'HTTP/1.1 ' + status + ' ' + text + '\r\n' +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Content-Length: ' + Buffer.byteLength(message) + '\r\n\r\n' +
      message,
  )
  destroyQuietly(socket)
}

function destroyQuietly(socket: Duplex): void {
  try {
    socket.destroy()
  } catch {
    // 已销毁时忽略。
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
