/**
 * ADB 层公共类型与错误。
 *
 * 设计约束（SPEC §3.2）：全线使用 `@yume-chan/adb`（Tango ADB）以纯 TypeScript
 * 直连实例的 TCP adbd 端口，不经过 adb server、不依赖任何 adb 二进制。
 */

import type { Adb, AdbCredentialStore } from '@yume-chan/adb'

/** adbd 的 TCP 端点。 */
export interface Endpoint {
  host: string
  port: number
}

export const DEFAULT_ADB_HOST = '127.0.0.1'
export const DEFAULT_ADB_PORT = 5555
export const DEFAULT_CONNECT_TIMEOUT_MS = 8_000
export const DEFAULT_SHELL_TIMEOUT_MS = 20_000
export const DEFAULT_PUSH_TIMEOUT_MS = 60_000

export function formatEndpoint(endpoint: Endpoint): string {
  return `${endpoint.host}:${endpoint.port}`
}

/** 解析 `host:port` 形式端点；格式非法时返回 `undefined`（不抛错，便于探测场景）。 */
export function parseEndpoint(value: string): Endpoint | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const index = trimmed.lastIndexOf(':')
  if (index <= 0 || index === trimmed.length - 1) return undefined
  const host = trimmed.slice(0, index)
  const portText = trimmed.slice(index + 1)
  if (!/^\d+$/.test(portText)) return undefined
  const port = Number(portText)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host, port }
}

/** 稳定标识，用于日志与去重。 */
export function endpointKey(endpoint: Endpoint): string {
  return formatEndpoint(endpoint)
}

export type AdbErrorCode =
  | 'connect'
  | 'timeout'
  | 'shell'
  | 'push'
  | 'closed'
  | 'protocol'
  /** 设备可连但尚未就绪（冷启动窗口内 screencap/命令输出异常）。 */
  | 'device-not-ready'

const RETRYABLE_CODES: readonly AdbErrorCode[] = [
  'connect',
  'timeout',
  'closed',
  'device-not-ready',
]

export class AdbError extends Error {
  readonly code: AdbErrorCode
  /** 是否值得重试（暂时性错误：boot 窗口/设备未就绪等）。 */
  readonly retryable: boolean

  constructor(
    message: string,
    code: AdbErrorCode,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, options)
    this.name = 'AdbError'
    this.code = code
    this.retryable = options?.retryable ?? RETRYABLE_CODES.includes(code)
  }
}

export class AdbTimeoutError extends AdbError {
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(message, 'timeout', options)
    this.name = 'AdbTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export interface AdbConnectOptions {
  /** TCP 连接 + ADB 认证握手的整体超时，默认 {@link DEFAULT_CONNECT_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 自定义密钥仓库（测试注入用；默认读/写 `~/.android/adbkey`）。 */
  credentialStore?: AdbCredentialStore
}

export interface ShellOptions {
  /** 单条 shell 命令超时，默认 {@link DEFAULT_SHELL_TIMEOUT_MS}。 */
  timeoutMs?: number
}

export interface PushOptions {
  /** push 整体超时，默认 {@link DEFAULT_PUSH_TIMEOUT_MS}。 */
  timeoutMs?: number
}

/**
 * 一条已建立的 ADB 连接。
 *
 * `raw` 是 Tango `Adb` 实例，透传给 stream 层（scrcpy 会话需要它）。
 */
export interface AdbConnection {
  readonly endpoint: Endpoint
  readonly serial: string
  /** 文本 shell（stdout+stderr 合并，UTF-8 解码）。 */
  shell(command: string, options?: ShellOptions): Promise<string>
  /** 二进制 shell 输出（如 `screencap -p`、`uiautomator dump` 的文件内容）。 */
  shellRaw(command: string, options?: ShellOptions): Promise<Uint8Array>
  /** 用 sync 协议写入设备文件（scrcpy-server jar 等）。 */
  push(local: Uint8Array, remotePath: string, options?: PushOptions): Promise<void>
  /** 幂等关闭；重复调用不抛错。 */
  close(): Promise<void>
  /** 连接断开时 resolve（不 reject，避免未处理拒绝）。 */
  readonly disconnected: Promise<void>
  readonly raw: Adb
}
