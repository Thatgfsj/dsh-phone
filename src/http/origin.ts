/** ctx.webServer.getOrigin 的安全读取（issue #71：listen 前调用会抛异常）。 */
export interface OriginProvider {
  getOrigin?(): string
}

export const FALLBACK_ORIGIN = 'http://127.0.0.1'

/** 拿 origin；未定义/空串/抛异常时回退 {@link FALLBACK_ORIGIN}。 */
export function safeGetOrigin(webServer: OriginProvider): string {
  try {
    const origin = webServer.getOrigin?.()
    return typeof origin === 'string' && origin.trim().length > 0 ? origin : FALLBACK_ORIGIN
  } catch {
    return FALLBACK_ORIGIN
  }
}
