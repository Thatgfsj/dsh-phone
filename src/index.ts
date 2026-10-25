/**
 * dsh-phone Host 插件入口（函数插件，禁止 default 导出）。
 *
 * 注册顺序（architecture §1）：config（schema）→ phone service → tools → http/ws。
 * 所有注册经 `ctx.effect`，卸载时逆序清理。
 * `enabled=false` 时只注册设置页需要的只读 GET /dsh-phone/api/config，
 * 不注册 9 个工具与视频流（开关权仅用户，SPEC §2/§6.4）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { AgentTokenStore } from './config/agent-token.ts'
import { Config as PhoneConfigSchema } from './config/schema.ts'
import type { PhoneConfig } from './config/schema.ts'
import type { SettingsFacade } from './config/write.ts'
import type { ConnectionLike } from './http/auth.ts'
import { API_PREFIX, createApiHandler, createReadOnlyHandler } from './http/routes.ts'
import type { ConfigView } from './http/routes.ts'
import type { AttachmentsLike } from './phone/contracts.ts'
import type { PhoneService } from './phone/service.ts'
import { createPhoneService, readOnboarding } from './phone/wiring.ts'
import type { PhoneStreamService, StreamConnectionFence } from './stream/index.ts'
import { createStreamUpgradeRoute } from './stream/index.ts'
import type { ToolHostLike } from './tools/common.ts'
import { registerPhoneTools } from './tools/index.ts'
import type { ShellApprovalHost } from './tools/shell-policy.ts'
import { registerShellApproval } from './tools/shell-policy.ts'

export const name = 'dsh-phone'

/** tools 为硬依赖：没有工具运行时本插件无意义。 */
export const inject = ['tools']

/** SPEC §6.1 全量配置 schema。 */
export const Config = PhoneConfigSchema

/** ctx.webServer 的最小结构（类型来自 dsh-host-webserver 的 cordis 增强，本包不依赖它）。 */
interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  }): () => void
  /** 本地监听 origin，如 http://127.0.0.1:3080（写进 agent.json 的 baseUrl）。 */
  getOrigin?(): string
}

interface WebHostContext {
  webServer: WebServerLike
}

function configView(config: PhoneConfig): ConfigView {
  return {
    enabled: config.enabled,
    runtime: config.runtime,
    onboarding: readOnboarding(config),
    stream: {
      maxSize: config.stream.maxSize,
      maxFps: config.stream.maxFps,
      bitrate: config.stream.bitrate,
    },
  }
}

/** ctx 的结构适配（只为测试可注入的 ToolHostLike）。 */
function toolHost(ctx: Context): ToolHostLike {
  return {
    tools: ctx.tools,
    effect: (callback) => {
      ctx.effect(() => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => undefined
      })
    },
  }
}

/** PhoneService → stream 层 PhoneStreamService（touch 命名差异在这里收敛）。 */
function streamService(service: PhoneService): PhoneStreamService {
  return {
    ensureRunning: () => service.ensureRunning(),
    startStream: (sink) => service.startStream(sink),
    touch: (action, x, y) => service.touchScreen(action, x, y),
    inputText: (text) => service.inputText(text),
    key: (name) => service.key(name),
  }
}

/** enabled=false：只注册设置页只读配置路由。 */
function registerReadOnly(ctx: Context, config: PhoneConfig): void {
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = (webCtx as unknown as WebHostContext).webServer
    const handler = createReadOnlyHandler({
      getSettings: () => ctx.get('settings') as SettingsFacade | undefined,
      getConnection: () => ctx.get('connection') as ConnectionLike | undefined,
      getConfigView: () => configView(config),
    })
    webCtx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => void handler.handle(req, res),
      }),
    )
  })
}

export function apply(ctx: Context, config: PhoneConfig): void {
  if (!config.enabled) {
    registerReadOnly(ctx, config)
    return
  }

  // 1) config → 2) phone service（懒启动，构造时不动外部资源）
  const service: PhoneService = createPhoneService(config)
  ctx.effect(() => () => void service.dispose())

  // 3) tools + phone_shell 审批（非白名单命令走 ask，SPEC §6.3）
  const attachments = (): AttachmentsLike | undefined =>
    ctx.get('attachments') as AttachmentsLike | undefined
  registerShellApproval(ctx as unknown as ShellApprovalHost)
  registerPhoneTools(toolHost(ctx), {
    service,
    attachments,
    // 首次使用守卫：每次工具调用实时读 volatile 配置（issue #30）
    onboarding: () => readOnboarding(config),
  })

  // 4) http + ws（web carrier 可选：无 webServer 时插件仍提供工具）
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = (webCtx as unknown as WebHostContext).webServer

    // 本地 Agent 通道 token（SPEC §5.2 步骤 6）：loopback + 无 Origin + token。
    const tokenStore = new AgentTokenStore()
    const agentReady = tokenStore.prepare(webServer.getOrigin?.() ?? 'http://127.0.0.1')
    void agentReady.catch(() => undefined)
    ctx.effect(() => () => {
      void tokenStore.dispose()
    })

    const api = createApiHandler({
      service,
      getSettings: () => ctx.get('settings') as SettingsFacade | undefined,
      getConnection: () => ctx.get('connection') as ConnectionLike | undefined,
      getConfigView: () => configView(config),
      agentAuth: async (req) => {
        await agentReady.catch(() => undefined)
        return tokenStore.verifyRequest(req)
      },
      recheckConnectivity: async () => {
        await service.ensureRunning()
        return service.status()
      },
    })
    webCtx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => void api.handle(req, res),
      }),
    )

    const fence = (): StreamConnectionFence | undefined =>
      ctx.get('connection') as unknown as StreamConnectionFence | undefined
    const route = createStreamUpgradeRoute({
      service: streamService(service),
      getConnection: fence,
      getStreamOptions: () => ({
        maxSize: config.stream.maxSize,
        maxFps: config.stream.maxFps,
        bitrate: config.stream.bitrate,
      }),
    })
    webCtx.effect(() => webServer.registerUpgrade(route))
  })
}