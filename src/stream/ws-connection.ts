/**
 * 单条 /dsh-phone/stream 连接的状态机：hello 时序、viewer attach/detach、
 * DPH1 封帧、控制消息转发、异常清理（docs/protocol.md §2）。
 *
 * 由 ws.ts 的路由工厂创建；每个 WebSocket 一个实例。
 */

import { peekDeviceSize } from './device-size.ts'
import { encodeFrame, FRAME_TYPE, microsToTicks, StreamClock } from './frames.ts'
import type { PhoneStreamService, StreamOptions, StreamSink } from './types.ts'
import type { WebSocketConnection } from './websocket.ts'
import type { StreamLogger } from './ws.ts'
import { parseClientMessage } from './ws-messages.ts'

export interface StreamConnectionOptions {
  service: PhoneStreamService
  options: StreamOptions
  helloTimeoutMs: number
  maxBufferedBytes: number
  /** 超过该时间未收到客户端消息 → 1011 断开（issue #73）。 */
  idleTimeoutMs: number
  logger?: StreamLogger
  onClosed: () => void
}

type OutboundMessage = Record<string, unknown>

export class StreamConnection {
  #ws: WebSocketConnection
  #options: StreamConnectionOptions
  #clock = new StreamClock()
  #helloDone = false
  #viewport = { w: 0, h: 0 }
  #release: (() => Promise<void>) | undefined
  #starting: Promise<void> | undefined
  #helloTimer: ReturnType<typeof setTimeout> | undefined
  #idleTimer: ReturnType<typeof setInterval> | undefined
  #lastClientMessageAt = 0
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
    this.#lastClientMessageAt = Date.now()
    this.#armIdleTimer()
  }

  close(code: number, reason: string): void {
    if (this.#closed) return
    this.#ws.close(code, reason)
  }

  async #onMessage(kind: 'text' | 'binary', data: Uint8Array): Promise<void> {
    if (this.#closed) return
    this.#lastClientMessageAt = Date.now()
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
      // 设备真实分辨率来自 scrcpy 启动时的 wm size 查询（device-size.ts 进程级快照）；
      // 解析失败则省略字段，客户端回退 hello viewport（向后兼容）。
      const device = peekDeviceSize()
      this.#send({
        type: 'ready',
        width: this.#viewport.w,
        height: this.#viewport.h,
        ...(device ? { deviceWidth: device.width, deviceHeight: device.height } : {}),
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
    this.#clearIdleTimer()
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
        if (this.#ws.bufferedBytes > this.#options.maxBufferedBytes) {
          // issue #73：所有帧都受背压——delta 可丢；configuration/keyframe 丢了会黑屏，
          // 直接断开让客户端重连拿新的 configuration + keyframe。
          if (type === FRAME_TYPE.delta) return
          this.#fail(1011, 'E_STREAM_BACKPRESSURE', 'WS 发送积压超过上限，已断开以恢复关键帧')
          return
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
    this.#clearIdleTimer()
    this.#ws.close(code, reason)
  }

  /** issue #73：服务端跟踪客户端消息；超过 idleTimeoutMs 无任何消息 → 1011。 */
  #armIdleTimer(): void {
    this.#clearIdleTimer()
    const idleTimeoutMs = this.#options.idleTimeoutMs
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return
    const interval = Math.max(10, Math.min(1000, Math.floor(idleTimeoutMs / 2)))
    this.#idleTimer = setInterval(() => {
      if (this.#closed) return
      if (Date.now() - this.#lastClientMessageAt >= idleTimeoutMs) {
        this.#fail(1011, 'E_STREAM_IDLE', '超过 ' + idleTimeoutMs + 'ms 未收到客户端消息（半开连接）')
      }
    }, interval)
    this.#idleTimer.unref?.()
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearInterval(this.#idleTimer)
      this.#idleTimer = undefined
    }
  }

  #logWarn(message: string): void {
    this.#options.logger?.warn('[dsh-phone] ' + message)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}