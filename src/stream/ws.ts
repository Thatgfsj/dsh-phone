/**
 * WS 路由 `/dsh-phone/stream`（docs/protocol.md §2，冻结）。
 *
 * host 有两种接入方式：
 * - `createStreamUpgradeHandler({ service, getConnection })`：host 自己
 *   `ctx.webServer.registerUpgrade`（推荐，同 host 其它路由装配方式一致）；
 * - `registerStreamRoute(ctx, deps?)`：stream 层自行注册（独立/测试场景）。
 *
 * 两者共用同一连接状态机与替换策略：同一时刻只保留一条流连接。
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { DEFAULT_STREAM_OPTIONS } from './types.ts'
import type { PhoneStreamService, StreamOptions } from './types.ts'
import { WebSocketConnection, WebSocketHandshakeError } from './websocket.ts'
import { StreamConnection } from './ws-connection.ts'
import { errorMessage } from './ws-connection.ts'

export const STREAM_PATH = '/dsh-phone/stream'
/** hello 必须在该时间内到达（docs/protocol.md：首条必须是 hello）。 */
export const DEFAULT_HELLO_TIMEOUT_MS = 5_000
/** 后端 socket 积压超过该值时丢弃 delta 帧，等下一个 keyframe（不拆包、不合包）。 */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export interface StreamLogger {
  warn(message: string): void
  error?(message: string): void
}

/** ctx.connection 的最小结构（requestRejection 返回 401/403/undefined）。 */
export interface StreamConnectionFence {
  requestRejection(request: IncomingMessage): 401 | 403 | undefined
}

export interface StreamUpgradeDeps {
  /** host 的 PhoneService（结构满足 PhoneStreamService）。 */
  service?: PhoneStreamService
  /** 延迟解析服务（registerStreamRoute 使用；与 service 二选一）。 */
  resolveService?: () => PhoneStreamService | Promise<PhoneStreamService> | undefined
  /** 返回 connection fence；缺省表示 host 已在调用前完成鉴权。 */
  getConnection?: () => StreamConnectionFence | undefined
  /** 当前 config.stream（ready 消息展示用）。 */
  getStreamOptions?: () => StreamOptions
  helloTimeoutMs?: number
  maxBufferedBytes?: number
  logger?: StreamLogger
}

/** 路由上下文的最小结构（ctx.webServer / ctx.connection 的冻结用法）。 */
export interface StreamRouteContext {
  webServer: {
    registerUpgrade(route: {
      path: string
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
    }): () => void
  }
  connection?: StreamConnectionFence | undefined
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

/**
 * 创建 upgrade handler（host 负责 registerUpgrade({ path: STREAM_PATH, handler })）。
 *
 * handler 内部完成：鉴权 → 同源旧连接替换 → WS 握手 → hello/控制/视频状态机。
 */
export function createStreamUpgradeHandler(
  deps: StreamUpgradeDeps,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const logger = deps.logger
  let active: StreamConnection | undefined

  function closeActive(code: number, reason: string): void {
    const previous = active
    active = undefined
    previous?.close(code, reason)
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const fence = deps.getConnection?.()
    if (deps.getConnection && !fence) return rejectUpgrade(socket, 503, 'no web carrier')
    if (fence) {
      const rejection = fence.requestRejection(req)
      if (rejection !== undefined) return rejectUpgrade(socket, rejection, 'rejected')
    }
    try {
      WebSocketConnection.verify(req)
    } catch (error) {
      if (error instanceof WebSocketHandshakeError) return rejectUpgrade(socket, error.status, error.message)
      throw error
    }

    const service = deps.resolveService ? await deps.resolveService() : deps.service
    if (!service) return rejectUpgrade(socket, 503, 'phone service unavailable')

    closeActive(1000, 'replaced')
    const ws = WebSocketConnection.accept(req, socket, head)
    const client = new StreamConnection(ws, {
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

  return (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch((error: unknown) => {
      logger?.warn('[dsh-phone] stream upgrade 失败: ' + errorMessage(error))
      destroyQuietly(socket)
    })
  }
}

/** 稳定入口：返回 { path, handler }，host 可直接 `ctx.webServer.registerUpgrade(route)`。 */
export function createStreamUpgradeRoute(deps: StreamUpgradeDeps): {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
} {
  return { path: STREAM_PATH, handler: createStreamUpgradeHandler(deps) }
}

/** 注册 upgrade 路由，返回 disposer（放进 ctx.effect 随插件卸载回收）。 */
export function registerStreamRoute(ctx: StreamRouteContext, deps: StreamRouteDeps = {}): () => void {
  // 延迟解析：ctx.get 在插件激活后才可用；服务缺失由 handler 内的 503 处理。
  const resolveService = (): PhoneStreamService | Promise<PhoneStreamService> | undefined =>
    deps.getService ? deps.getService() : fromContext(ctx)
  const handler = createStreamUpgradeHandler({
    resolveService,
    getConnection: () => ctx.connection,
    getStreamOptions: deps.getStreamOptions,
    helloTimeoutMs: deps.helloTimeoutMs,
    maxBufferedBytes: deps.maxBufferedBytes,
    logger: deps.logger ?? ctx.logger,
  })
  return ctx.webServer.registerUpgrade({ path: STREAM_PATH, handler })
}

function fromContext(ctx: StreamRouteContext): PhoneStreamService | undefined {
  for (const key of SERVICE_KEYS) {
    const candidate = ctx.get?.(key)
    if (candidate) return candidate as PhoneStreamService
  }
  return undefined
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
