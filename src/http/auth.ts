/**
 * 鉴权：所有 HTTP/WS 请求先过 `ctx.connection.requestRejection(req)`（docs/protocol.md §0）。
 * `ctx.connection` 缺失（无 web carrier）时拒绝而非放行（calibration §3）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { ApiError, sendError } from './json.ts'

export interface ConnectionLike {
  requestRejection(req: IncomingMessage): number | undefined
}

/**
 * 返回拒绝信息；`undefined` 表示放行。
 * - connection 缺失 → 503 E_NO_WEB
 * - requestRejection 返回 401 → E_AUTH；其它（403）→ E_ORIGIN
 */
export function rejectionFor(
  connection: ConnectionLike | undefined,
  req: IncomingMessage,
): ApiError | undefined {
  if (!connection) {
    return new ApiError(503, 'E_NO_WEB', '当前 profile 没有 web carrier / connection 服务')
  }
  const status = connection.requestRejection(req)
  if (status === undefined) return undefined
  if (status === 401) {
    return new ApiError(401, 'E_AUTH', '请求未通过 DSH connection 层认证')
  }
  return new ApiError(403, 'E_ORIGIN', '请求来源（Origin/Host）未通过同源校验')
}

export function sendRejection(res: ServerResponse, rejection: ApiError): void {
  sendError(res, rejection.status, rejection.code, rejection.message, rejection.retryable)
}
