/**
 * PhoneService 的纯工具（issue #83 从 service.ts 拆出）：探测防抖指纹、endpoint 解析、错误归一。
 */
import type { Endpoint } from '../runtime/types.ts'
import type { ServiceConfig } from './service-types.ts'

/**
 * 探测失败后的最短重探间隔（issue #36）：失败**不永久缓存**，但 30s 内不重复探测，
 * 避免面板/status 轮询打爆决策树（docker/emulator 探测含磁盘与端口检查）。
 */
export const RUNTIME_PROBE_RETRY_MS = 30_000

/** 运行时探测缓存指纹：runtime 配置 + onboarding.status/choice 任一变化即失效。 */
export function runtimeConfigFingerprint(config: ServiceConfig): string {
  const onboarding = config.onboarding
  // issue #70：attach.endpoint/resolved 变化必须使 adapter+ADB 缓存失效（否则写新端点不生效）
  return [
    config.runtime,
    onboarding?.status ?? '',
    onboarding?.choice ?? '',
    config.attach.endpoint,
    config.attach.resolved ? '1' : '0',
  ].join('|')
}

export function parseEndpoint(value: string): Endpoint | undefined {
  const match = /^([A-Za-z0-9._:[\]-]+):(\d{1,5})$/.exec(value.trim())
  if (!match) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host: match[1] as string, port }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
