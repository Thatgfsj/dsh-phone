/**
 * attach 适配器：连接用户本机已存在的模拟器/真机。
 *
 * 语义（SPEC §3.5）：**不是插件的资源**，因此
 * - ensureRunning 只做“连接校验”，绝不启动/修改外部进程；
 * - pause 不休眠（no-op）；
 * - stop 只断开连接，不关闭用户实例（连接生命周期归 service 层）。
 */

import { AdbError } from '../adb/types.ts'
import { formatEndpoint, parseEndpoint } from './types.ts'
import { RuntimeError } from './types.ts'
import type {
  AttachOptions,
  BootPhase,
  Endpoint,
  RuntimeAdapter,
  RuntimeEnvironment,
  RuntimeProbe,
  RuntimeStatus,
} from './types.ts'

export interface AttachRuntimeOptions {
  attach: AttachOptions
  env: RuntimeEnvironment
  /** ensureRunning 的端口等待上限，默认 2s。 */
  readyTimeoutMs?: number
}

export class AttachRuntime implements RuntimeAdapter {
  readonly kind = 'attach' as const
  readonly #attach: AttachOptions
  readonly #env: RuntimeEnvironment
  readonly #readyTimeoutMs: number
  #endpoint: Endpoint | undefined
  #since: number | undefined
  #reachable = false

  constructor(options: AttachRuntimeOptions) {
    this.#attach = options.attach
    this.#env = options.env
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 2_000
    this.#endpoint = parseEndpoint(options.attach.endpoint)
  }

  get endpoint(): Endpoint | undefined {
    return this.#endpoint
  }

  async probe(): Promise<RuntimeProbe> {
    if (!this.#endpoint) {
      if (this.#attach.userHint.trim()) {
        return {
          ok: false,
          reason: 'attach.endpoint 未解析（userHint 待解析：需宿主接入流程验证连通后写入）',
        }
      }
      return { ok: false, reason: '未配置 attach.endpoint' }
    }
    if (this.#attach.endpoint && !this.#attach.resolved) {
      return {
        ok: true,
        reason: 'attach.endpoint 已填写但 resolved=false（按 SPEC §6.2 R5 需先验证连通）',
        detail: formatEndpoint(this.#endpoint),
      }
    }
    const open = await this.#env.waitForPort(this.#endpoint, {
      timeoutMs: 1_500,
      intervalMs: 250,
    })
    return open
      ? { ok: true, detail: `${formatEndpoint(this.#endpoint)} 可连接` }
      : {
          ok: false,
          reason: `${formatEndpoint(this.#endpoint)} 不可达（实例未启动或 adbd 未就绪）`,
        }
  }

  /** 只连接校验，不启动任何外部进程。 */
  async ensureRunning(
    onProgress?: (message: string, phase?: BootPhase) => void,
  ): Promise<Endpoint> {
    const endpoint = this.#endpoint
    if (!endpoint) {
      throw new RuntimeError(
        this.#attach.userHint.trim()
          ? 'attach 端点待解析：请先完成接入流程（解析 userHint 并写入 attach.endpoint）'
          : 'attach 端点未配置：请在设置里填写 attach.endpoint（如 127.0.0.1:5555）',
        'attach-unresolved',
      )
    }

    onProgress?.(`校验 attach 端点 ${formatEndpoint(endpoint)}…`, 'waiting-adbd')
    const open = await this.#env.waitForPort(endpoint, {
      timeoutMs: this.#readyTimeoutMs,
      intervalMs: 250,
    })
    if (!open) {
      throw new RuntimeError(
        `attach 端点 ${formatEndpoint(endpoint)} 不可达：请确认模拟器/真机已启动、已开启 adb TCP 调试（attach 不会替你启动实例）`,
        'start',
      )
    }

    this.#reachable = true
    this.#since ??= Date.now()
    onProgress?.(`attach 端点 ${formatEndpoint(endpoint)} 可连接`, 'ready')
    return endpoint
  }

  /** attach 实例不是插件资源：休眠 = 什么都不做（只允许 service 层断开连接）。 */
  async pause(): Promise<void> {
    this.#reachable = false
  }

  async resume(): Promise<void> {
    await this.ensureRunning()
  }

  /** 只断开连接；实例保持运行（用户自己的模拟器/真机不动）。 */
  async stop(): Promise<void> {
    this.#reachable = false
    this.#since = undefined
  }

  /** 看门狗用（issue #83）：attach 是 adopted，只用端口/连通性判断。 */
  async isAlive(): Promise<boolean> {
    if (!this.#endpoint) return false
    return this.#env.waitForPort(this.#endpoint, { timeoutMs: 300 }).catch(() => false)
  }

  async status(): Promise<RuntimeStatus> {
    if (!this.#endpoint) {
      return { kind: 'attach', running: false, paused: false, owned: false, adopted: true }
    }
    const open = await this.#env.waitForPort(this.#endpoint, {
      timeoutMs: 400,
      intervalMs: 100,
    })
    this.#reachable = open
    return {
      kind: 'attach',
      running: open,
      paused: false,
      owned: false,
      adopted: true,
      endpoint: this.#endpoint,
      since: this.#since,
    }
  }
}

/** attach 断连/校验失败的通用错误归一化（供 service 层复用）。 */
export function attachFailure(error: unknown, endpoint?: Endpoint): RuntimeError {
  if (error instanceof RuntimeError) return error
  const suffix = endpoint ? `（${formatEndpoint(endpoint)}）` : ''
  if (error instanceof AdbError) {
    return new RuntimeError(`attach 连接失败${suffix}: ${error.message}`, 'start')
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RuntimeError(`attach 连接失败${suffix}: ${message}`, 'start')
}
