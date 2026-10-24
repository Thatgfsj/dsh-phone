/** HTTP JSON/PNG 响应与请求体工具（docs/protocol.md §0 统一形状）。 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ApiErrorBody {
  ok: false
  error: { code: string; message: string; retryable: boolean; bootMs?: number }
}

export type ApiSuccessBody = { ok: true; value: unknown }

/** 路由层统一错误：status/code/retryable 决定响应。 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly bootMs?: number

  constructor(status: number, code: string, message: string, retryable = false, bootMs?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
    if (bootMs !== undefined) this.bootMs = bootMs
  }
}

export function noStore(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store')
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(payload))
  noStore(res)
  res.end(payload)
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryable = false,
  bootMs?: number,
): void {
  const body: ApiErrorBody = { ok: false, error: { code, message, retryable } }
  if (bootMs !== undefined) body.error.bootMs = bootMs
  sendJson(res, status, body)
}

export function sendSuccess(res: ServerResponse, value: unknown, status = 200): void {
  const body: ApiSuccessBody = { ok: true, value }
  sendJson(res, status, body)
}

export function sendPng(res: ServerResponse, bytes: Uint8Array, cacheControl = 'no-store'): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Content-Length', bytes.byteLength)
  res.setHeader('Cache-Control', cacheControl)
  res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

const MAX_BODY_BYTES = 16 * 1024

/** 读取并解析 JSON 请求体；非法 JSON/超限抛 400 E_BAD_REQUEST。 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'E_BAD_REQUEST', '请求体超过 ' + MAX_BODY_BYTES + ' 字节'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new ApiError(400, 'E_BAD_REQUEST', '请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => {
      reject(new ApiError(400, 'E_BAD_REQUEST', '读取请求体失败: ' + String(error)))
    })
  })
}
