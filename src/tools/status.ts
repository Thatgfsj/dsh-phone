import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { type ToolDeps } from './common.ts'

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
    endpoint: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', required: true },
        port: { type: 'integer', required: true },
      },
    },
    lastError: { type: 'string' },
    // runtime 决策树全失败时的结构化错误（与其它工具 E_RUNTIME_UNAVAILABLE 语义一致）
    ok: { type: 'boolean' },
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
  endpoint?: { host: string; port: number }
  lastError?: string
  ok?: boolean
  code?: string
  retryable?: boolean
  hints?: string[]
}

function renderStatus(status: StatusLike): string {
  const parts = [`state=${status.state}`, `runtime=${status.runtime}`, `platform=${status.platform}`]
  if (status.state === 'booting' && status.bootMs !== undefined) parts.push(`bootMs=${status.bootMs}`)
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
      '查询 dsh-phone 管理的 Android 实例状态。任何任务的第一步必调。返回 state（stopped/booting/running/paused）、runtime（redroid/emulator/attach）、platform、cpuPct/memPct/uptimeMs/bootMs/endpoint。state=booting 时等待后重试，不要中断任务；state=paused 时任意 phone_* 调用会自动唤醒。',
    parameters: {},
    isConcurrencySafe: () => true,
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute() {
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