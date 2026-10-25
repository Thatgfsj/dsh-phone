/**
 * 9 个工具共用的输出契约、booting 中间态与错误映射。
 *
 * 统一成功体 / 错误体（docs/protocol.md §0 的 JSON 形状在工具层同构）：
 * - 成功：`{ ok:true, message?, data? }`
 * - booting：`{ ok:false, code:'E_BOOTING', retryable:true, bootMs }`（**不抛错**）
 * - 失败：`{ ok:false, code, message, retryable, hints? }`
 */
import { onboardingFailure } from '../config/onboarding.ts'
import type { JsonValue, OnboardingState } from '../config/onboarding.ts'
import type { AttachmentsLike, PhoneOperations } from '../phone/contracts.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export interface ToolFailure {
  ok: false
  code: string
  message: string
  retryable: boolean
  bootMs?: number
  hints?: string[]
  /** 首次使用守卫的提问结构（issue #30；仅 E_ONBOARDING_* 带）。 */
  onboarding?: JsonValue
}

export interface ToolSuccess {
  ok: true
  message?: string
}

export type ToolResult = ToolSuccess | ToolFailure

/** 统一输出 schema（值必须与 render 一致；additionalProperties 必须显式声明）。 */
export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    code: { type: 'string' },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    bootMs: { type: 'integer' },
    hints: { type: 'array', items: { type: 'string' } },
    onboarding: { type: 'json' },
  },
} as const

/** render 的输入：成功/失败共用（避免 discriminated union 在泛型 schema 下不兼容）。 */
export interface RenderableResult {
  ok: boolean
  code?: string
  message?: string
  retryable?: boolean
  bootMs?: number
  hints?: readonly string[]
  onboarding?: JsonValue
}

/** ContentBlock 文本块（不 import dsh-llm，保持 host 工具层解耦）。 */
export interface TextBlockLike {
  type: 'text'
  text: string
}

export function renderResult(value: RenderableResult): TextBlockLike[] {
  if (value.ok) {
    return [{ type: 'text', text: value.message ?? 'ok' }]
  }
  let text = (value.code || 'E_DEVICE_COMMAND') + ': ' + value.message
  if (value.bootMs !== undefined) {
    text += '（启动中 ' + value.bootMs + 'ms；稍后先调 phone_status 再重试，禁止中断任务）'
  }
  if (value.retryable && value.bootMs === undefined) text += ' [可重试]'
  if (value.hints && value.hints.length > 0) text += '\n' + value.hints.join('\n')
  if (value.onboarding !== undefined) {
    text += '\n' + JSON.stringify(value.onboarding, null, 2)
  }
  return [{ type: 'text', text }]
}

export function bootingFailure(bootMs: number): ToolFailure {
  return {
    ok: false,
    code: 'E_BOOTING',
    message: 'Android 实例正在启动/wake 中，等待后就绪（不视为失败）',
    retryable: true,
    bootMs,
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 运行时/ADB 错误 → 工具结构化错误码（docs/protocol.md §3）。 */
export function failureFrom(error: unknown): ToolFailure {
  const message = errorMessage(error)
  const code = errorCode(error)
  const hints = (error as { hints?: unknown } | null)?.hints
  const guide = (error as { guide?: unknown } | null)?.guide

  if (code === 'unavailable') {
    const list: string[] = []
    if (typeof guide === 'string') list.push(guide)
    if (Array.isArray(hints)) list.push(...hints.filter((h): h is string => typeof h === 'string'))
    return { ok: false, code: 'E_RUNTIME_UNAVAILABLE', message, retryable: false, hints: list }
  }
  if (code === 'attach-unresolved') {
    return { ok: false, code: 'E_RUNTIME_UNAVAILABLE', message, retryable: false }
  }
  if (code === 'timeout') {
    return { ok: false, code: 'E_TIMEOUT', message, retryable: true }
  }
  // issue #44：冷启动窗口内设备尚未就绪 → 复用 E_BOOTING 可重试语义
  if (code === 'device-not-ready') {
    return bootingFailure(0)
  }
  if (code === 'E_BOOTING') {
    const bootMs = (error as { bootMs?: unknown } | null)?.bootMs
    return bootingFailure(typeof bootMs === 'number' ? bootMs : 0)
  }
  return { ok: false, code: 'E_DEVICE_COMMAND', message, retryable: true }
}

/** 读取当前 onboarding 状态（未注入时视作 accepted，兼容 #4 既有单测）。 */
export function currentOnboarding(deps: ToolDeps): OnboardingState {
  return deps.onboarding?.() ?? { status: 'accepted', choice: '' }
}

/** 工具执行骨架：首次使用守卫 → 前置 readiness → 动作 → 结构化结果。 */
export async function guarded(
  deps: ToolDeps,
  action: () => Promise<{ message?: string } | void>,
): Promise<ToolResult> {
  // 硬规则（issue #30）：用户明确同意前不得 ensureRunning/碰设备
  const onboarding = onboardingFailure(currentOnboarding(deps))
  if (onboarding) return onboarding

  const service = deps.service
  let readiness
  try {
    readiness = await service.ensureInteractive()
  } catch (error) {
    return failureFrom(error)
  }
  if (readiness.state === 'booting') return bootingFailure(readiness.bootMs)

  try {
    const result = await action()
    const success: ToolSuccess = { ok: true }
    if (result && result.message !== undefined) success.message = result.message
    return success
  } catch (error) {
    return failureFrom(error)
  }
}

/** 每个工具工厂的依赖：PhoneService + onboarding 状态 + 可选的 attachments 服务。 */
export interface ToolDeps {
  service: PhoneOperations
  /** 当前 onboarding 状态（index 从 volatile 配置实时读取；未注入视作 accepted）。 */
  onboarding?(): OnboardingState
  /** ctx.get('attachments')——缺失时 phone_screenshot 降级为文本。 */
  attachments?(): AttachmentsLike | undefined
}

/** 工具层注册所需的 ctx 结构（测试注入假实现）。 */
export interface ToolRegistryLike {
  register(definition: ToolDefinition): () => void
}

export interface ToolHostLike {
  tools: ToolRegistryLike
  effect(callback: () => (() => void) | void): void
}