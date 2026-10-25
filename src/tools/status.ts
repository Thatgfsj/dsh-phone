import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { onboardingFailure } from '../config/onboarding.ts'
import type { JsonValue } from '../config/onboarding.ts'
import { currentOnboarding, type ToolDeps } from './common.ts'

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', required: true },
    runtime: { type: 'string', required: true },
    platform: { type: 'string', required: true },
    cpuPct: { type: 'number' },
    memPct: { type: 'number' },
    uptimeMs: { type: 'integer' },
    bootMs: { type: 'integer' },
    phase: { type: 'string' },
    endpoint: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', required: true },
        port: { type: 'integer', required: true },
      },
    },
    lastError: { type: 'string' },
    // runtime 决策树全失败 / onboarding 守卫的结构化错误
    ok: { type: 'boolean' },
    message: { type: 'string' },
    onboarding: { type: 'json' },
    code: { type: 'string' },
    retryable: { type: 'boolean' },
    hints: { type: 'array', items: { type: 'string' } },
  },
} as const

interface StatusLike {
  state: string
  runtime: string
  platform: string
  cpuPct?: number
  memPct?: number
  uptimeMs?: number
  bootMs?: number
  phase?: string
  endpoint?: { host: string; port: number }
  lastError?: string
  ok?: boolean
  code?: string
  retryable?: boolean
  hints?: string[]
  onboarding?: JsonValue
}

function renderStatus(status: StatusLike): string {
  const parts = [`state=${status.state}`, `runtime=${status.runtime}`, `platform=${status.platform}`]
  if (status.state === 'booting' && status.bootMs !== undefined) parts.push(`bootMs=${status.bootMs}`)
  if (status.state === 'booting' && status.phase) parts.push('phase=' + status.phase)
  if (status.endpoint) parts.push(`endpoint=${status.endpoint.host}:${status.endpoint.port}`)
  if (status.cpuPct !== undefined) parts.push(`cpuPct=${status.cpuPct}`)
  if (status.memPct !== undefined) parts.push(`memPct=${status.memPct}`)
  if (status.uptimeMs !== undefined) parts.push(`uptimeMs=${status.uptimeMs}`)
  if (status.lastError) parts.push(`lastError=${status.lastError}`)
  if (status.code) parts.unshift(`${status.code}: ${status.lastError ?? ''}`.trim())
  if (status.hints && status.hints.length > 0) {
    return parts.join(' ') + '\n' + status.hints.join('\n')
  }
  return parts.join(' ')
}

/** phone_status：任何任务的第一步；并发安全。 */
export function createStatusTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_status',
    description:
      '查询 dsh-phone 管理的 Android 实例状态。任何任务的第一步必调。返回 state（stopped/booting/running/paused）、runtime（redroid/emulator/attach）、platform、cpuPct/memPct/uptimeMs/bootMs/endpoint。state=booting 时返回 bootMs 与可选 phase（launching/waiting-adbd/connecting-adb/ready），等待后重试，不要中断任务；state=paused 时任意 phone_* 调用会自动唤醒。',
    parameters: {},
    isConcurrencySafe: () => true,
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute() {
      // issue #30：首次使用守卫优先于一切设备/运行时动作
      const onboarding = onboardingFailure(currentOnboarding(deps))
      if (onboarding) {
        return {
          ...onboarding,
          state: 'stopped',
          runtime: 'attach',
          platform: 'other',
          lastError: onboarding.message,
        }
      }
      try {
        return await deps.service.status()
      } catch (error) {
        // 与其它工具一致：runtime 不可用返回结构化 E_RUNTIME_UNAVAILABLE + 安装指引
        const hints = (error as { hints?: unknown } | null)?.hints
        return {
          state: 'stopped',
          runtime: 'attach',
          platform: 'other',
          lastError: error instanceof Error ? error.message : String(error),
          ok: false,
          code: 'E_RUNTIME_UNAVAILABLE',
          retryable: false,
          hints: Array.isArray(hints)
            ? hints.filter((hint): hint is string => typeof hint === 'string')
            : [],
        }
      }
    },
  })
}