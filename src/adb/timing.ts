/** 超时工具（ADB 层与运行时层共用，避免引入额外依赖）。 */

export function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  makeError: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {
        // onTimeout 只做清理，失败不应掩盖超时错误
      }
      reject(makeError())
    }, timeoutMs)
    // 不要因为这个定时器把进程挂住（Node 端插件长驻运行时）
    timer.unref?.()
  })

  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** 轮询直到 `check` 返回 true 或超时；返回是否在超时前就绪。 */
export async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() >= deadline) return false
    const delay = Math.min(intervalMs, Math.max(0, deadline - Date.now()))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay)
      timer.unref?.()
    })
  }
}
