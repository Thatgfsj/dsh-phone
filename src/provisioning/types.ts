/**
 * 一键准备运行环境（provisioning）契约，issue #65。
 *
 * Host 在**用户明确点击**后执行白名单命令：安装 SDK emulator + system image、
 * 接受许可、创建/复用 dsh-phone-avd；不执行任意用户字符串、不安装无关包、
 * 不修改用户其它 AVD（插件只创建/复用 `dsh-phone-avd`）。
 */
import type { Platform } from '../runtime/types.ts'

export const PROVISION_RUNTIMES = ['emulator', 'redroid', 'attach'] as const
export type ProvisionRuntime = (typeof PROVISION_RUNTIMES)[number]

export const PROVISION_IMAGES = ['google_apis', 'aosp_atd'] as const
export type ProvisionImage = (typeof PROVISION_IMAGES)[number]

export const PROVISION_STATES = ['idle', 'running', 'done', 'failed'] as const
export type ProvisionState = (typeof PROVISION_STATES)[number]

/** GET /dsh-phone/api/provision 的返回形状（客户端 #67 依赖，字段保持稳定）。 */
export interface ProvisionStatus {
  state: ProvisionState
  /** 当前阶段（idle / precheck / install / licenses / avd / verify / done / failed）。 */
  step: string
  /** 0–100 的阶段估算/解析进度。 */
  percent: number
  /** 最近 50 行日志（命令、输出摘要、错误）。 */
  log: string[]
  error?: string
  runtime?: ProvisionRuntime
}

export interface ProvisionRequest {
  runtime: ProvisionRuntime
  image?: ProvisionImage
}

/** 磁盘预检下限：3GB（issue #65）。 */
export const MIN_FREE_DISK_BYTES = 3 * 1024 * 1024 * 1024
/** 单次 provision 总超时：15 分钟。 */
export const PROVISION_TIMEOUT_MS = 15 * 60_000
/** 日志环形缓冲行数。 */
export const PROVISION_LOG_LIMIT = 50
/** 默认 AVD 名（与 runtime/install-guide 的 AVD_NAME 一致）。 */
export const PROVISION_AVD_NAME = 'dsh-phone-avd'
/** 默认镜像（与 install-guide 的 SYSTEM_IMAGE 一致）。 */
export const PROVISION_SYSTEM_IMAGE = 'system-images;android-34;google_apis;x86_64'
/** aosp_atd 快启动镜像。 */
export const PROVISION_SYSTEM_IMAGE_ATD = 'system-images;android-34;aosp_atd;x86_64'
/** 安装包白名单（固定参数；不安装其它包）。 */
export const PROVISION_EMULATOR_PACKAGE = 'emulator'

export function isProvisionRuntime(value: unknown): value is ProvisionRuntime {
  return typeof value === 'string' && (PROVISION_RUNTIMES as readonly string[]).includes(value)
}

export function isProvisionImage(value: unknown): value is ProvisionImage {
  return typeof value === 'string' && (PROVISION_IMAGES as readonly string[]).includes(value)
}

export function systemImageFor(image: ProvisionImage | undefined): string {
  return image === 'aosp_atd' ? PROVISION_SYSTEM_IMAGE_ATD : PROVISION_SYSTEM_IMAGE
}

/** 可注入的宿主环境/命令能力（单测用假实现，不装任何东西）。 */
export interface SdkTools {
  sdkmanager: string
  avdmanager: string
}

export interface ProvisionDeps {
  runner: {
    run(
      file: string,
      args: readonly string[],
      options?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> },
    ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>
    kill?(pid: number, signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): Promise<boolean>
    isProcessAlive?(pid: number): Promise<boolean>
  }
  platform(): Promise<Platform>
  pathExists(path: string): Promise<boolean>
  hasCommand(command: string): Promise<boolean>
  findEmulator(): Promise<string | undefined>
  findAvdManager(): Promise<string | undefined>
  /** 宿主可用磁盘字节数（默认对 SDK 根/home 做 statfs；测试注入）。 */
  freeDiskBytes(): Promise<number>
  /** R5/attach：校验 endpoint（复用 PhoneService.verifyEndpoint，不落盘）。 */
  verifyEndpoint(endpoint: string): Promise<{ ok: boolean; latencyMs: number; banner?: string; error?: string }>
  /** 当前配置的 attach.endpoint（空串表示未配置）。 */
  getAttachEndpoint(): string
  /** 可注入时钟（进度估算与测试）。 */
  now?(): number
}

/** 供 HTTP 层调用（避免 routes 依赖具体实现）。 */
export interface ProvisionerLike {
  status(): ProvisionStatus
  start(request: ProvisionRequest): ProvisionStatus
  dispose(): void
}
