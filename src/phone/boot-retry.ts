/**
 * 冷启动窗口内的 ADB 连接重试策略（issue #44）。
 *
 * 现象：emulator/redroid 冷启动时 adbd 端口很快可连，但 ADB 认证握手/执行命令
 * 仍可能失败（系统还没 boot_completed），一次 8s 握手超时就抛错会让用户手动重试。
 *
 * 策略：在 booting 窗口（默认 120s）内按 500ms → 1s → 2s → 4s → 8s（封顶）
 * 退避重试，直到成功或窗口耗尽；窗口耗尽才抛最后一次错误，并标注可重试。
 *
 * 本模块只做纯计算，sleep/时钟由 PhoneService 注入（单测不真的等）。
 */

import { AdbError } from '../adb/types.ts'

/** booting 窗口上限（与服务创建 lifecycle 时传入的 bootTimeoutMs 一致）。 */
export const DEFAULT_BOOT_TIMEOUT_MS = 120_000
/** 首次重试延迟。 */
export const BOOT_RETRY_BASE_MS = 500
/** 单次重试延迟上限（避免窗口后段间隔过大）。 */
export const BOOT_RETRY_MAX_DELAY_MS = 8_000

/**
 * 生成 boot 窗口内的重试延迟序列：500, 1000, 2000, 4000, 8000, 8000, ...
 * 保证累计延迟不超过 maxTotalMs（因此尝试次数 = 延迟数 + 1）。
 */
export function bootRetryDelays(maxTotalMs: number = DEFAULT_BOOT_TIMEOUT_MS): number[] {
  if (!Number.isFinite(maxTotalMs) || maxTotalMs <= 0) return []
  const delays: number[] = []
  let spent = 0
  let delay = BOOT_RETRY_BASE_MS
  while (spent + delay <= maxTotalMs) {
    delays.push(delay)
    spent += delay
    delay = Math.min(delay * 2, BOOT_RETRY_MAX_DELAY_MS)
  }
  return delays
}

/**
 * 是否值得在 boot 窗口内重试：
 * - ADB 层错误（握手超时/连接被拒/连接中断/设备未就绪等）都是暂时性的；
 * - 其它带 retryable: true 标记的错误也重试；
 * - 普通 Error（配置/参数错误）不重试，避免把真错误拖 120s。
 */
export function isRetryableBootError(error: unknown): boolean {
  if (error instanceof AdbError) return true
  const record = error as { retryable?: unknown; code?: unknown } | null
  if (record?.retryable === true) return true
  return (
    record?.code === 'timeout' ||
    record?.code === 'connect' ||
    record?.code === 'closed' ||
    record?.code === 'shell' ||
    record?.code === 'device-not-ready'
  )
}

/** 重试耗尽后的错误文案：保留最后一次原因，标注重试次数与窗口。 */
export function bootRetryExhaustedMessage(
  attempts: number,
  maxTotalMs: number,
  lastError: Error,
): string {
  const windowSeconds = Math.round(maxTotalMs / 1000)
  return (
    `冷启动窗口中 ADB 仍未就绪（已尝试 ${attempts} 次 / 约 ${windowSeconds}s）：${lastError.message}` +
    '。实例可能仍在开机，稍后重试即可（无需手工重启运行时）。'
  )
}
