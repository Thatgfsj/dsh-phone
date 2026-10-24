/**
 * scrcpy-server.jar 懒下载（issue #37）。
 *
 * 首次 `startStream` / `startControlOnly` 时若 `assets/scrcpy-server.jar` 缺失，
 * 自动调用现有下载器（scripts/fetch-scrcpy-server.mjs：官方 URL → 镜像回退 → sha256
 * 校验 → 原子落盘），同进程 single-flight；失败返回结构化错误（含手工命令、可重试）。
 *
 * 覆盖路径：环境变量 `DSH_PHONE_SCRCPY_SERVER`（自定义 jar，不做自动下载）；
 * 显式构造参数 `path/downloader` 供测试注入。
 */

import { unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  fetchServer,
  SERVER_LICENSE,
  SERVER_SHA256,
  verifyFile,
} from '../../scripts/fetch-scrcpy-server.mjs'

/** 自定义 scrcpy-server.jar 路径（可选；存在时不自动下载）。 */
export const SERVER_JAR_ENV = 'DSH_PHONE_SCRCPY_SERVER'
/** 失败时给用户/日志的手工命令（离线/排障用）。 */
export const MANUAL_FETCH_COMMAND = 'node scripts/fetch-scrcpy-server.mjs'
/** 懒下载超时（网络慢时可重试）。 */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180_000

const HERE = dirname(fileURLToPath(import.meta.url))

/** 默认缓存位置：<repo>/assets/scrcpy-server.jar（.gitignore 忽略）。 */
export function defaultServerJarPath(): string {
  return resolve(HERE, '..', '..', 'assets', 'scrcpy-server.jar')
}

/** 实际使用的 jar 路径：环境变量优先，否则默认 assets 路径。 */
export function serverJarPath(): string {
  return process.env[SERVER_JAR_ENV] ?? defaultServerJarPath()
}

export type JarErrorCode = 'E_SCRCPY_SERVER_UNAVAILABLE' | 'E_SCRCPY_SERVER_TIMEOUT'

export interface JarErrorOptions {
  code: JarErrorCode
  path: string
  expectedSha256: string
  retryable: boolean
  detail?: string
  cause?: unknown
}

/** 结构化错误：ws 层可直接把 message 下发给客户端；manualCommand 供日志/文档。 */
export class ScrcpyServerUnavailableError extends Error {
  readonly code: JarErrorCode
  readonly retryable: boolean
  readonly path: string
  readonly expectedSha256: string
  readonly manualCommand = MANUAL_FETCH_COMMAND
  readonly license = SERVER_LICENSE
  readonly detail: string | undefined

  constructor(message: string, options: JarErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'ScrcpyServerUnavailableError'
    this.code = options.code
    this.retryable = options.retryable
    this.path = options.path
    this.expectedSha256 = options.expectedSha256
    this.detail = options.detail
  }
}

export type JarDownloader = (destination: string) => Promise<unknown>

export interface ScrcpyServerJarProviderOptions {
  /** 覆盖目标路径（默认 {@link serverJarPath}）。 */
  path?: string
  /** 覆盖下载器（测试注入；默认复用 scripts/fetch-scrcpy-server.mjs）。 */
  downloader?: JarDownloader
  /** 下载超时，默认 180s。 */
  timeoutMs?: number
  /** 期望 sha256，默认官方 v3.3.3 的值。 */
  expectedSha256?: string
}

class DownloadTimeoutError extends Error {}

/**
 * 懒下载器：同进程 single-flight（并发 ensure 共享一次下载），
 * 失败后清除 in-flight，下一次调用可重试。
 */
export class ScrcpyServerJarProvider {
  #downloader: JarDownloader | undefined
  #path: string | undefined
  #timeoutMs: number
  #expectedSha256: string
  #downloading: Promise<string> | undefined

  constructor(options: ScrcpyServerJarProviderOptions = {}) {
    this.#downloader = options.downloader
    this.#path = options.path
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
    this.#expectedSha256 = options.expectedSha256 ?? SERVER_SHA256
  }

  get path(): string {
    return this.#path ?? serverJarPath()
  }

  get downloading(): boolean {
    return this.#downloading !== undefined
  }

  /** 确保 jar 就绪：已存在且校验通过直接返回；否则懒下载（single-flight）。 */
  async ensure(): Promise<string> {
    const path = this.path
    const expected = this.#expectedSha256
    const existing = await verifyFile(path, expected)
    if (existing.ok) return path

    if (this.#isEnvOverride()) {
      throw new ScrcpyServerUnavailableError(
        '环境变量 ' + SERVER_JAR_ENV + ' 指向的 scrcpy-server.jar 不存在或 sha256 不匹配（' +
          path + '）；请修正该路径，或取消环境变量后自动下载',
        {
          code: 'E_SCRCPY_SERVER_UNAVAILABLE',
          path,
          expectedSha256: expected,
          retryable: false,
          detail: existing.missing ? 'file missing' : 'sha256 mismatch: ' + existing.actual,
        },
      )
    }

    if (this.#downloading) return this.#downloading
    const task = this.#downloadAndVerify(path, expected).finally(() => {
      if (this.#downloading === task) this.#downloading = undefined
    })
    this.#downloading = task
    return task
  }

  #isEnvOverride(): boolean {
    return this.#path === undefined && Boolean(process.env[SERVER_JAR_ENV])
  }

  async #downloadAndVerify(path: string, expected: string): Promise<string> {
    try {
      await withTimeout(this.#download(path, expected), this.#timeoutMs)
    } catch (error) {
      if (error instanceof ScrcpyServerUnavailableError) throw error
      const timedOut = error instanceof DownloadTimeoutError
      throw new ScrcpyServerUnavailableError(
        (timedOut
          ? '下载 scrcpy-server.jar 超时（' + this.#timeoutMs + 'ms，网络较慢）'
          : '下载 scrcpy-server.jar 失败：' + errorMessage(error)) +
          '；可重试，或手工运行「' + MANUAL_FETCH_COMMAND + '」',
        {
          code: timedOut ? 'E_SCRCPY_SERVER_TIMEOUT' : 'E_SCRCPY_SERVER_UNAVAILABLE',
          path,
          expectedSha256: expected,
          retryable: true,
          cause: error,
          detail: errorMessage(error),
        },
      )
    }

    const verified = await verifyFile(path, expected)
    if (!verified.ok) {
      await unlink(path).catch(() => {})
      throw new ScrcpyServerUnavailableError(
        'scrcpy-server.jar sha256 校验失败（期望 ' + expected + '，实际 ' +
          (verified.actual || '缺失') + '）；文件已删除，请重试或手工运行「' + MANUAL_FETCH_COMMAND + '」',
        {
          code: 'E_SCRCPY_SERVER_UNAVAILABLE',
          path,
          expectedSha256: expected,
          retryable: true,
          detail: 'sha256 mismatch',
        },
      )
    }
    return path
  }

  #download(path: string, expected: string): Promise<unknown> {
    if (this.#downloader) return this.#downloader(path)
    // TS 对 .mjs 的 async 函数返回类型推断不完整，用 Promise.resolve 归一化。
    return Promise.resolve(fetchServer({ destination: path, expectedSha256: expected }))
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DownloadTimeoutError('download timeout')), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 进程级单例（scrcpy 启动使用；测试直接 new ScrcpyServerJarProvider 注入）。 */
export const scrcpyServerJarProvider = new ScrcpyServerJarProvider()

/** 便捷入口：确保 jar 就绪并返回路径。 */
export function ensureScrcpyServer(): Promise<string> {
  return scrcpyServerJarProvider.ensure()
}
