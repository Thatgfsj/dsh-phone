/**
 * dsh-phone Host 插件入口（函数插件，禁止 default 导出）。
 *
 * 注册顺序（architecture §1）：config（schema）→ phone service → tools → http/ws。
 * 所有注册经 `ctx.effect`，卸载时逆序清理。
 * `enabled=false` 时只注册设置页需要的只读 GET /dsh-phone/api/config，
 * 不注册 9 个工具与视频流（开关权仅用户，SPEC §2/§6.4）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { Config as PhoneConfigSchema } from './config/schema.ts'
import type { PhoneConfig } from './config/schema.ts'
import type { SettingsFacade } from './config/write.ts'
import type { ConnectionLike } from './http/auth.ts'
import { API_PREFIX, createApiHandler, createReadOnlyHandler } from './http/routes.ts'
import type { ConfigView } from './http/routes.ts'
import type { AttachmentsLike } from './phone/contracts.ts'
import type { PhoneService } from './phone/service.ts'
import { createPhoneService } from './phone/wiring.ts'
import type { StreamConnectionFence } from './stream/index.ts'
import { createStreamUpgradeRoute } from './stream/index.ts'
import type { ToolHostLike } from './tools/common.ts'
import { registerPhoneTools } from './tools/index.ts'
import { evaluateShellCommand } from './tools/shell-policy.ts'

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
}

interface WebHostContext {
  webServer: WebServerLike
}

function configView(config: PhoneConfig): ConfigView {
  return {
    runtime: config.runtime,
    stream: {
      maxSize: config.stream.maxSize,
      maxFps: config.stream.maxFps,
      bitrate: config.stream.bitrate,
    },
  }
}

/** phone_shell 审批：非白名单命令返回 ask（waterfall，architecture §2.2）。 */
function registerShellApproval(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'phone_shell') return next()
    const args = exec.arguments as { cmd?: unknown } | undefined
    const command = typeof args?.cmd === 'string' ? args.cmd : ''
    const decision = evaluateShellCommand(command)
    if (decision.kind === 'allow') return next()
    const ask: PreToolDecision = {
      kind: 'ask',
      reason: decision.reason,
      displayReason: decision.displayReason,
    }
    return ask
  })
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

  // 3) tools + phone_shell 审批
  const attachments = (): AttachmentsLike | undefined =>
    ctx.get('attachments') as AttachmentsLike | undefined
  registerShellApproval(ctx)
  registerPhoneTools(toolHost(ctx), { service, attachments })

  // 4) http + ws（web carrier 可选：无 webServer 时插件仍提供工具）
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = (webCtx as unknown as WebHostContext).webServer
    const api = createApiHandler({
      service,
      getSettings: () => ctx.get('settings') as SettingsFacade | undefined,
      getConnection: () => ctx.get('connection') as ConnectionLike | undefined,
      getConfigView: () => configView(config),
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
      service,
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
