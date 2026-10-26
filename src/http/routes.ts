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
import {
  isOnboardingChoice,
  isOnboardingStatus,
  onboardingFailure,
} from '../config/onboarding.ts'
import type { OnboardingState, OnboardingToolFailure } from '../config/onboarding.ts'
import type { SettingsFacade } from '../config/write.ts'
import {
  AppDrawerUnavailableError,
  isPhoneAction,
  runPhoneAction,
} from '../phone/actions.ts'
import type { PhoneOperations, PhoneStatus } from '../phone/contracts.ts'
import { isRuntimeAction } from '../phone/lifecycle-control.ts'
import type { LifecycleControllerLike, RuntimeAction } from '../phone/lifecycle-control.ts'
import {
  isProvisionImage,
  isProvisionRuntime,
} from '../provisioning/types.ts'
import type { ProvisionerLike } from '../provisioning/types.ts'
import { RuntimeUnavailableError } from '../runtime/types.ts'
import { rejectionFor, sendRejection } from './auth.ts'
import type { ConnectionLike } from './auth.ts'
import { ApiError, readJsonBody, sendError, sendJson, sendPng, sendSuccess } from './json.ts'

export const API_PREFIX = '/dsh-phone/api'

export interface ConfigView {
  /** 插件总开关（Config.enabled，非 volatile；只读展示，变更需重载）。 */
  enabled: boolean
  runtime: string
  /** 首次使用守卫状态（issue #30）；面板据此决定是否展示引导。 */
  onboarding: OnboardingState
  stream: { maxSize: number; maxFps: number; bitrate: number }
}

export interface ConfigSnapshot {
  /** 插件总开关（只读；客户端据此显示「已启用/已关闭（只读）」）。 */
  enabled: boolean
  runtime: string
  onboarding: OnboardingState
  attach: { endpoint: string; userHint: string; resolved: boolean }
  stream: { maxSize: number; maxFps: number; bitrate: number }
  revision: number
}

export interface HttpRouteDeps {
  service: PhoneOperations
  /** 生命周期控制（issue #83）：GET/POST /runtime。 */
  lifecycle: LifecycleControllerLike
  /** 一键准备运行环境（issue #65）；仅浏览器同源请求可触发。 */
  provisioner: ProvisionerLike
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
  /** 可注入时钟（verified TTL 单测；默认 Date.now）。 */
  now?(): number
}

export interface HttpRouteHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const ENDPOINT_PATTERN = /^([A-Za-z0-9._:[\]-]+):(\d{1,5})$/

/** R5 verify 结果的有效期（issue #71）：过期后需重新 verify。 */
export const VERIFY_TTL_MS = 5 * 60_000

/** Agent 通道允许写入的 key（issue #71：不得自授权 onboarding、不得改 userHint）。 */
export const AGENT_WRITABLE_PATHS: readonly string[] = ['attach.endpoint', 'attach.resolved']

/** attach 端点只允许 loopback + 非特权端口（防止 token 持有者做内网端口探测）。 */
export function isLoopbackEndpointString(value: unknown): value is string {
  if (!isValidEndpointString(value)) return false
  const trimmed = value.trim()
  const index = trimmed.lastIndexOf(':')
  const host = trimmed.slice(0, index).toLowerCase()
  const port = Number(trimmed.slice(index + 1))
  const loopback =
    host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  return loopback && port >= 1024
}

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
  const onboarding = (readPath(descriptor.value, ['onboarding']) ?? {}) as Record<string, unknown>
  return {
    enabled: view.enabled === true,
    runtime: view.runtime,
    onboarding: {
      status: isOnboardingStatus(onboarding.status) ? onboarding.status : view.onboarding.status,
      choice: isOnboardingChoice(onboarding.choice) ? onboarding.choice : view.onboarding.choice,
    },
    attach: {
      endpoint: typeof attach.endpoint === 'string' ? attach.endpoint : '',
      userHint: typeof attach.userHint === 'string' ? attach.userHint : '',
      resolved: attach.resolved === true,
    },
    stream: view.stream,
    revision: descriptor.revision,
  }
}

/** 200 + 结构化 onboarding 错误体（待用户答复；面板展示引导而不是报错）。 */
function sendOnboardingFailure(res: ServerResponse, failure: OnboardingToolFailure): void {
  sendJson(res, 200, {
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...(failure.onboarding === undefined ? {} : { onboarding: failure.onboarding }),
    },
  })
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
  // issue #44：设备尚未就绪（冷启动窗口内截图输出异常）按可重试的 booting 中间态返回
  if ((error as { code?: unknown } | null)?.code === 'device-not-ready') {
    return new ApiError(200, 'E_BOOTING', '设备正在就绪（可能仍在开机），稍后重试', true)
  }
  // issue #44：设备尚未就绪（冷启动窗口内截图输出异常）按可重试的 booting 中间态返回
  if ((error as { code?: unknown } | null)?.code === 'device-not-ready') {
    return new ApiError(200, 'E_BOOTING', '设备正在就绪（可能仍在开机），稍后重试', true)
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
  /** R5：本进程内通过 /attach/verify 连通验证过的端点 → 过期时间（带 TTL，issue #71）。 */
  const verified = new Map<string, number>()
  /** 面板动作互斥（issue #100）：同一时刻只允许一个动作。 */
  let actionInFlight = false
  const now = (): number => deps.now?.() ?? Date.now()
  const isVerified = (endpoint: string): boolean => {
    const expiresAt = verified.get(endpoint)
    return expiresAt !== undefined && expiresAt > now()
  }

  async function handleVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readJsonBody(req))
    const endpoint = body.endpoint
    if (!isValidEndpointString(endpoint)) {
      throw new ApiError(400, 'E_BAD_REQUEST', 'endpoint 必须是 host:port，如 127.0.0.1:5555')
    }
    if (!isLoopbackEndpointString(endpoint)) {
      throw new ApiError(
        400,
        'E_BAD_REQUEST',
        'attach.endpoint 只允许 loopback（127.0.0.1/localhost/::1）且端口 ≥1024；' +
          '插件只连接本机 adb（禁止内网端口探测）',
      )
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
    if (result.ok) verified.set(endpoint, now() + VERIFY_TTL_MS)
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
    // issue #71：Agent 通道不得自授权（onboarding.*）、不得改 userHint（R2）；只允许 endpoint/resolved。
    if (options.viaAgent === true && !AGENT_WRITABLE_PATHS.includes(pathKey(path))) {
      throw new ApiError(
        403,
        'E_FORBIDDEN',
        '本地 Agent 通道只允许写 attach.endpoint / attach.resolved；' +
          pathKey(path) + ' 只能由浏览器同源通道（用户设置页）写入',
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
    if (pathKey(path) === 'onboarding.status' && !isOnboardingStatus(body.value)) {
      throw new ApiError(400, 'E_BAD_REQUEST', 'onboarding.status 必须是 pending/accepted/declined')
    }
    if (pathKey(path) === 'onboarding.choice' && !isOnboardingChoice(body.value)) {
      throw new ApiError(
        400,
        'E_BAD_REQUEST',
        'onboarding.choice 必须是空串/emulator/redroid/attach',
      )
    }
    // issue #71：revision 必填（CAS）；缺失即拒绝，避免 last-write-wins 绕过并发保护。
    const revision = body.revision
    if (revision === undefined) {
      throw new ApiError(
        400,
        'E_BAD_REQUEST',
        '缺少 revision：请先 GET /dsh-phone/api/config 取 revision，再带 revision 写入（CAS）',
      )
    }
    if (typeof revision !== 'number' || !Number.isInteger(revision)) {
      throw new ApiError(400, 'E_BAD_REQUEST', 'revision 必须是整数')
    }

    const current = configSnapshot(deps)
    const key = pathKey(path)
    // R5：先验证后落盘
    if (key === 'attach.endpoint') {
      if (!isValidEndpointString(body.value)) {
        throw new ApiError(400, 'E_BAD_REQUEST', 'attach.endpoint 必须是 host:port')
      }
      if (!isLoopbackEndpointString(body.value)) {
        throw new ApiError(400, 'E_BAD_REQUEST', 'attach.endpoint 只允许 loopback 且端口 ≥1024')
      }
      if (!isVerified(body.value)) {
        throw new ApiError(
          409,
          'E_NOT_VERIFIED',
          '该 endpoint 尚未通过 POST /dsh-phone/api/attach/verify 连通验证（R5）',
        )
      }
    }
    if (key === 'attach.resolved' && body.value === true) {
      if (
        !isValidEndpointString(current.attach.endpoint) ||
        !isVerified(current.attach.endpoint)
      ) {
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

  function onboardingGuard(): OnboardingToolFailure | undefined {
    return onboardingFailure(deps.getConfigView().onboarding)
  }

  async function handleProvision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readJsonBody(req))
    if (!isProvisionRuntime(body.runtime)) {
      throw new ApiError(400, 'E_BAD_REQUEST', 'runtime 必须是 emulator/redroid/attach')
    }
    if (body.image !== undefined && !isProvisionImage(body.image)) {
      throw new ApiError(400, 'E_BAD_REQUEST', 'image 必须是 google_apis/aosp_atd')
    }
    const status = deps.provisioner.start({
      runtime: body.runtime,
      ...(body.image === undefined ? {} : { image: body.image }),
    })
    sendSuccess(res, status)
  }

  async function handleScreenshot(res: ServerResponse): Promise<void> {
    // issue #30：首次使用守卫优先，不触发懒启动/截图
    const blocked = onboardingGuard()
    if (blocked) {
      sendOnboardingFailure(res, blocked)
      return
    }
    const readiness = await deps.service.ensureInteractive()
    if (readiness.state === 'booting') {
      sendError(res, 200, 'E_BOOTING', '实例正在启动，稍后重试截图', true, readiness.bootMs)
      return
    }
    const bytes = await deps.service.screenshot()
    sendPng(res, bytes)
  }

  /** POST /runtime：异步入队 + 202；stop 仅浏览器同源（agent token → 403）。 */
  async function handleRuntimeAction(
    req: IncomingMessage,
    res: ServerResponse,
    options: { viaAgent: boolean },
  ): Promise<void> {
    const body = asRecord(await readJsonBody(req))
    const action = body.action
    if (!isRuntimeAction(action)) {
      throw new ApiError(400, 'E_BAD_REQUEST', "action 必须是 start/stop/restart")
    }
    if (options.viaAgent && action === 'stop') {
      throw new ApiError(
        403,
        'E_FORBIDDEN',
        'stop（关闭手机）只能由用户在浏览器点击；Agent 通道只允许 start/restart 自愈',
      )
    }
    const before = await deps.lifecycle.info()
    deps.lifecycle.enqueue(action as RuntimeAction)
    // 202 + 扁平体（issue #83 冻结）：{ok,action,state}；UI 轮询 GET /runtime
    sendJson(res, 202, { ok: true, action, state: before.state })
  }

  /** POST /action（issue #100）：固定动作 + 固定命令；agent token 也允许。 */
  async function handleAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const blocked = onboardingGuard()
    if (blocked) {
      sendOnboardingFailure(res, blocked)
      return
    }
    const body = asRecord(await readJsonBody(req))
    if (!isPhoneAction(body.action)) {
      throw new ApiError(400, 'E_BAD_REQUEST', "action 目前只支持 'app-drawer'")
    }
    const info = await deps.lifecycle.info()
    if (info.busy || actionInFlight) {
      throw new ApiError(409, 'E_LIFECYCLE_BUSY', '生命周期/面板动作正在执行，请稍后重试', true)
    }
    actionInFlight = true
    try {
      await runPhoneAction(body.action, deps.service)
      // issue #100 冻结成功体：200 flat {ok:true}
      sendJson(res, 200, { ok: true })
    } catch (error) {
      if (error instanceof AppDrawerUnavailableError) {
        throw new ApiError(409, 'E_APP_DRAWER_UNAVAILABLE', error.message, error.retryable)
      }
      throw error
    } finally {
      actionInFlight = false
    }
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
      const isRuntimeRoute = rawPath === '/runtime'
      const agentEligible =
        isAgentConfig ||
        (method === 'POST' && rawPath === '/attach/verify') ||
        (method === 'GET' && rawPath === '/status') ||
        // issue #71：Agent 需要读 revision 才能做 CAS 写入
        (method === 'GET' && rawPath === '/config') ||
        // issue #83：Agent 可自愈（start/restart）；stop 在 handler 内按 action 拒绝
        (isRuntimeRoute && (method === 'GET' || method === 'POST')) ||
        // issue #100：面板「应用」动作允许 agent token（固定命令，无注入面）
        (method === 'POST' && rawPath === '/action')

      let agentAuthorized = false
      const rejection = rejectionFor(deps.getConnection(), req)
      if (rejection) {
        const agentOk = agentEligible && deps.agentAuth !== undefined
          ? await deps.agentAuth(req)
          : false
        if (!agentOk) {
          sendRejection(res, rejection)
          return
        }
        agentAuthorized = true
      }

      if (method === 'GET' && rawPath === '/status') {
        // issue #30：pending/declined 返回 200 + 结构化 onboarding（面板不报错）
        const blocked = onboardingGuard()
        if (blocked) {
          sendOnboardingFailure(res, blocked)
          return
        }
        sendSuccess(res, await deps.service.status())
        return
      }
      if (method === 'GET' && rawPath === '/runtime') {
        sendSuccess(res, await deps.lifecycle.info())
        return
      }
      if (method === 'POST' && rawPath === '/runtime') {
        await handleRuntimeAction(req, res, { viaAgent: agentAuthorized })
        return
      }
      if (method === 'POST' && rawPath === '/action') {
        await handleAction(req, res)
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
      if (method === 'GET' && rawPath === '/provision') {
        sendSuccess(res, deps.provisioner.status())
        return
      }
      if (method === 'POST' && rawPath === '/provision') {
        await handleProvision(req, res)
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