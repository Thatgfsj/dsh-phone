/**
 * HTTP 路由：GET/POST /dsh-phone/api/{status,config,attach/verify,screenshot}。
 *
 * 契约见 docs/protocol.md（冻结）：
 * - 所有请求先过 `ctx.connection.requestRejection(req)`；
 * - 成功体 `{ok:true,value}`，错误体 `{ok:false,error:{code,message,retryable}}`；
 * - config/status/screenshot 一律 `Cache-Control: no-store`；
 * - POST /config 只允许 attach.endpoint / attach.resolved / attach.userHint 三键（R1）；
 * - R5：endpoint 未通过 POST /attach/verify 实际连通验证前禁止落盘；
 * - R4：写后 describe 回读（writeConfigValue）+ 重新 phone_status 复验。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ConfigWriteError,
  describeEntry,
  isWritablePath,
  pathKey,
  readPath,
  writeConfigValue,
} from '../config/write.ts'
import type { SettingsFacade } from '../config/write.ts'
import type { PhoneOperations, PhoneStatus } from '../phone/contracts.ts'
import { RuntimeUnavailableError } from '../runtime/types.ts'
import { rejectionFor, sendRejection } from './auth.ts'
import type { ConnectionLike } from './auth.ts'
import { ApiError, readJsonBody, sendError, sendPng, sendSuccess } from './json.ts'

export const API_PREFIX = '/dsh-phone/api'

export interface ConfigView {
  runtime: string
  stream: { maxSize: number; maxFps: number; bitrate: number }
}

export interface ConfigSnapshot {
  runtime: string
  attach: { endpoint: string; userHint: string; resolved: boolean }
  stream: { maxSize: number; maxFps: number; bitrate: number }
  revision: number
}

export interface HttpRouteDeps {
  service: PhoneOperations
  /**
   * 本地 Agent 通道鉴权（POST /agent/config）：loopback + 无 Origin + token 匹配。
   * 返回 true 时绕过 ctx.connection.requestRejection；否则仍走原有校验。
   */
  agentAuth?(req: IncomingMessage): Promise<boolean> | boolean
  getSettings(): SettingsFacade | undefined
  getConnection(): ConnectionLike | undefined
  /** 非 volatile 配置（runtime/stream）的实时读取。 */
  getConfigView(): ConfigView
  /** R4b：写 endpoint/resolved 后重新拉起并确认 phone_status=running。 */
  recheckConnectivity(): Promise<PhoneStatus>
}

export interface HttpRouteHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const ENDPOINT_PATTERN = /^([A-Za-z0-9._:[\]-]+):(\d{1,5})$/

/** 校验 `host:port` 端点字符串（端口 1–65535）。 */
export function isValidEndpointString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ENDPOINT_PATTERN.exec(value.trim())
  if (!match) return false
  const port = Number(match[2])
  return Number.isInteger(port) && port > 0 && port <= 65535
}

interface SnapshotSource {
  getSettings(): SettingsFacade | undefined
  getConfigView(): ConfigView
}

function configSnapshot(deps: SnapshotSource): ConfigSnapshot {
  const descriptor = describeEntry(deps.getSettings())
  const attach = (readPath(descriptor.value, ['attach']) ?? {}) as Record<string, unknown>
  const view = deps.getConfigView()
  return {
    runtime: view.runtime,
    attach: {
      endpoint: typeof attach.endpoint === 'string' ? attach.endpoint : '',
      userHint: typeof attach.userHint === 'string' ? attach.userHint : '',
      resolved: attach.resolved === true,
    },
    stream: view.stream,
    revision: descriptor.revision,
  }
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'E_BAD_REQUEST', '请求体必须是 JSON 对象')
  }
  return body as Record<string, unknown>
}

function mapConfigError(res: ServerResponse, error: ConfigWriteError): void {
  switch (error.code) {
    case 'bad-path':
      sendError(res, 400, 'E_BAD_PATH', error.message)
      return
    case 'conflict':
      sendError(res, 409, 'E_CONFIG_CONFLICT', error.message, true)
      return
    case 'verify':
      sendError(res, 500, 'E_DEVICE_COMMAND', error.message, true)
      return
    default:
      sendError(res, 503, 'E_NO_WEB', error.message)
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  // 决策树全失败：503 + 安装指引（docs/protocol.md §3、issue #28）
  if (error instanceof RuntimeUnavailableError) {
    return new ApiError(503, 'E_RUNTIME_UNAVAILABLE', error.message, false)
  }
  if (error instanceof ConfigWriteError) {
    if (error.code === 'conflict') return new ApiError(409, 'E_CONFIG_CONFLICT', error.message, true)
    if (error.code === 'bad-path') return new ApiError(400, 'E_BAD_PATH', error.message)
    return new ApiError(503, 'E_NO_WEB', error.message)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ApiError(500, 'E_DEVICE_COMMAND', message, true)
}

export function createApiHandler(deps: HttpRouteDeps): HttpRouteHandler {
  /** R5：本进程内通过 /attach/verify 实际连通验证过的端点（不落盘）。 */
  const verified = new Set<string>()

  async function handleVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readJsonBody(req))
    const endpoint = body.endpoint
    if (!isValidEndpointString(endpoint)) {
      throw new ApiError(400, 'E_BAD_REQUEST', 'endpoint 必须是 host:port，如 127.0.0.1:5555')
    }
    let result
    try {
      result = await deps.service.verifyEndpoint(endpoint)
    } catch (error) {
      result = {
        ok: false,
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (result.ok) verified.add(endpoint)
    else verified.delete(endpoint)
    sendSuccess(res, result)
  }

  async function handleConfigWrite(
    req: IncomingMessage,
    res: ServerResponse,
    options: { viaAgent?: boolean } = {},
  ): Promise<void> {
    const body = asRecord(await readJsonBody(req))
    const rawPath = body.path
    if (
      !Array.isArray(rawPath) ||
      rawPath.length === 0 ||
      !rawPath.every((segment): segment is string => typeof segment === 'string')
    ) {
      throw new ApiError(400, 'E_BAD_REQUEST', 'path 必须是字符串数组，如 ["attach","endpoint"]')
    }
    const path = rawPath as string[]
    if (!isWritablePath(path)) {
      throw new ApiError(
        400,
        'E_BAD_PATH',
        '不允许写入 ' + pathKey(path) + '；只允许 attach.endpoint / attach.resolved / attach.userHint',
      )
    }
    // SPEC §6.2 R2：userHint 原文只由用户在设置页修改；本地 Agent 通道禁止写。
    if (options.viaAgent === true && pathKey(path) === 'attach.userHint') {
      throw new ApiError(
        403,
        'E_FORBIDDEN',
        '本地 Agent 通道不得修改 attach.userHint（SPEC §6.2 R2：一句话只由用户在设置页修改）',
      )
    }
    if (!('value' in body)) {
      throw new ApiError(400, 'E_BAD_REQUEST', '缺少 value 字段')
    }
    // 字段类型校验：错误必须 400（不能被 ConfigWriteError 映射成 503）
    if (pathKey(path) === 'attach.userHint' && typeof body.value !== 'string') {
      throw new ApiError(400, 'E_BAD_REQUEST', 'attach.userHint 必须是字符串')
    }
    if (pathKey(path) === 'attach.resolved' && typeof body.value !== 'boolean') {
      throw new ApiError(400, 'E_BAD_REQUEST', 'attach.resolved 必须是布尔值')
    }
    const revision = body.revision
    if (revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision))) {
      throw new ApiError(400, 'E_BAD_REQUEST', 'revision 必须是整数')
    }

    const current = configSnapshot(deps)
    const key = pathKey(path)
    // R5：先验证后落盘
    if (key === 'attach.endpoint') {
      if (!isValidEndpointString(body.value)) {
        throw new ApiError(400, 'E_BAD_REQUEST', 'attach.endpoint 必须是 host:port')
      }
      if (!verified.has(body.value)) {
        throw new ApiError(
          409,
          'E_NOT_VERIFIED',
          '该 endpoint 尚未通过 POST /dsh-phone/api/attach/verify 连通验证（R5）',
        )
      }
    }
    if (key === 'attach.resolved' && body.value === true) {
      if (!isValidEndpointString(current.attach.endpoint) || !verified.has(current.attach.endpoint)) {
        throw new ApiError(
          409,
          'E_NOT_VERIFIED',
          '当前 attach.endpoint 尚未通过 /attach/verify 验证，不能标记 resolved=true（R5）',
        )
      }
    }

    try {
      await writeConfigValue(deps.getSettings(), path, body.value, revision)
    } catch (error) {
      if (error instanceof ConfigWriteError) {
        mapConfigError(res, error)
        return
      }
      throw error
    }

    // R4 第二重验证：重新拉起（attach 即重连）并确认 phone_status=running
    if (key === 'attach.endpoint' || (key === 'attach.resolved' && body.value === true)) {
      const status = await deps.recheckConnectivity()
      if (status.state !== 'running') {
        throw new ApiError(
          502,
          'E_DEVICE_DISCONNECTED',
          '配置已写入，但写入后 phone_status 复验未达到 running（' +
            status.state + (status.lastError ? ': ' + status.lastError : '') + '）',
          true,
        )
      }
    }
    sendSuccess(res, configSnapshot(deps))
  }

  async function handleScreenshot(res: ServerResponse): Promise<void> {
    const readiness = await deps.service.ensureInteractive()
    if (readiness.state === 'booting') {
      sendError(res, 200, 'E_BOOTING', '实例正在启动，稍后重试截图', true, readiness.bootMs)
      return
    }
    const bytes = await deps.service.screenshot()
    sendPng(res, bytes)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rawPath = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length) || '/'
        : url.pathname
      const method = (req.method ?? 'GET').toUpperCase()
      const isAgentConfig = method === 'POST' && rawPath === '/agent/config'
      // 无浏览器 cookie 的 Agent 需要走：verify（R5）→ agent/config（R1）→ status（R4b）
      const agentEligible =
        isAgentConfig ||
        (method === 'POST' && rawPath === '/attach/verify') ||
        (method === 'GET' && rawPath === '/status')

      const rejection = rejectionFor(deps.getConnection(), req)
      if (rejection) {
        const agentOk = agentEligible && deps.agentAuth !== undefined
          ? await deps.agentAuth(req)
          : false
        if (!agentOk) {
          sendRejection(res, rejection)
          return
        }
      }

      if (method === 'GET' && rawPath === '/status') {
        sendSuccess(res, await deps.service.status())
        return
      }
      if (method === 'GET' && rawPath === '/config') {
        sendSuccess(res, configSnapshot(deps))
        return
      }
      if (method === 'POST' && rawPath === '/config') {
        await handleConfigWrite(req, res)
        return
      }
      if (isAgentConfig) {
        await handleConfigWrite(req, res, { viaAgent: true })
        return
      }
      if (method === 'POST' && rawPath === '/attach/verify') {
        await handleVerify(req, res)
        return
      }
      if (method === 'GET' && rawPath === '/screenshot') {
        await handleScreenshot(res)
        return
      }
      throw new ApiError(404, 'E_BAD_REQUEST', '未知路由: ' + method + ' ' + rawPath)
    } catch (error) {
      const apiError = toApiError(error)
      sendError(res, apiError.status, apiError.code, apiError.message, apiError.retryable)
    }
  }

  return { handle }
}
/** enabled=false 时设置页需要的只读路由：仅 GET /config（不注册工具/流/写接口）。 */
export interface ReadOnlyRouteDeps extends SnapshotSource {
  getConnection(): ConnectionLike | undefined
}

export function createReadOnlyHandler(deps: ReadOnlyRouteDeps): HttpRouteHandler {
  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const rejection = rejectionFor(deps.getConnection(), req)
      if (rejection) {
        sendRejection(res, rejection)
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const rawPath = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length) || '/'
          : url.pathname
        if ((req.method ?? 'GET').toUpperCase() === 'GET' && rawPath === '/config') {
          sendSuccess(res, configSnapshot(deps))
          return
        }
        throw new ApiError(
          403,
          'E_NO_WEB',
          '插件开关已关闭（dsh-phone.enabled=false）：只提供只读配置查询；开关变更权属于用户',
        )
      } catch (error) {
        const apiError = toApiError(error)
        sendError(res, apiError.status, apiError.code, apiError.message, apiError.retryable)
      }
    },
  }
}