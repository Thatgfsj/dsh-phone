/**
 * PhoneService 的依赖/窄接口类型（issue #83 从 service.ts 拆出，控制单文件行数）。
 * 对外仍由 src/phone/service.ts re-export，既有 import 不受影响。
 */
import type { OnboardingChoice, OnboardingStatus } from '../config/onboarding.ts'
import type { Endpoint, PhoneState, RuntimeAdapter, RuntimeKind } from '../runtime/types.ts'
import type { Platform } from './contracts.ts'

export interface ServiceConfig {
  /** 生效运行时（已叠加 onboarding.choice；wiring.readServiceConfig）。 */
  runtime: 'auto' | RuntimeKind
  /** onboarding 原始状态：用于配置变化时使探测缓存失效（issue #36）。 */
  onboarding?: { status: OnboardingStatus; choice: OnboardingChoice }
  attach: { endpoint: string; userHint: string; resolved: boolean }
  stream: { maxSize: number; maxFps: number; bitrate: number }
  lifecycle: { idleTimeoutMs: number; pausedTimeoutMs: number }
}

/** runtime 适配器 + 决策树结果（detect.ts / resolveRuntime 的窄化）。 */
export interface RuntimeHandle {
  adapter: RuntimeAdapter
  detection: { kind: RuntimeKind; platform: Platform }
}

export interface AdbConnectionLike {
  readonly raw: unknown
  readonly disconnected: Promise<void>
  close(): Promise<void>
}

/** adb/device 设备语义（src/adb/device.ts 的窄化，测试可注入假实现）。 */
export interface DeviceOps {
  screenshot(): Promise<Uint8Array>
  tap(x: number, y: number): Promise<void>
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>
  key(name: string): Promise<void>
  appLaunch(pkg: string): Promise<void>
  dumpUi(): Promise<string>
  shell(command: string): Promise<string>
}

export interface StreamSink {
  video(chunk: Uint8Array, meta?: { keyframe?: boolean; pts?: bigint }): void
  error(error: Error): void
}

export interface StreamSessionOptions {
  /** 必须是 AdbConnection 本身（stream 层内部读 adb.raw）；禁止传 Tango Adb/.raw（issue #59）。 */
  adb: AdbConnectionLike
  video: boolean
  sink?: StreamSink
  config: { maxSize: number; maxFps: number; bitrate: number }
}

export interface StreamSession {
  readonly ready?: Promise<{ width: number; height: number; codec: string }>
  injectText(text: string): Promise<void>
  injectTouch(action: 'down' | 'move' | 'up', x: number, y: number): Promise<void>
  injectKey(name: string): Promise<void>
  close(): Promise<void>
}

export type StartStreamSession = (options: StreamSessionOptions) => Promise<StreamSession>

/** 生命周期状态（runtime PhoneLifecycle 的窄化）。 */
export interface LifecycleStatusLike {
  state: PhoneState
  since: number
  bootMs?: number
  lastError?: string
}

export interface LifecycleHooksLike {
  start(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  onError?(error: Error, phase: 'start' | 'resume' | 'pause' | 'stop'): void
}

export interface LifecycleLike {
  readonly state: PhoneState
  readonly status: LifecycleStatusLike
  ensureRunning(): Promise<void>
  touch(options?: { wake?: boolean }): void
  notifyDisconnected(reason?: string): void
  /** issue #83：立即强制停止（打断 booting，不调 hooks.stop）。 */
  halt(reason?: string): void
  /** issue #83：有序停止（调 hooks.stop，保存快照）。 */
  stopNow(reason?: string): Promise<void>
  onChange(listener: (status: LifecycleStatusLike) => void): () => void
  dispose(): Promise<void>
}

export type CreateLifecycle = (
  hooks: LifecycleHooksLike,
  timings: { idleTimeoutMs: number; pausedTimeoutMs: number; bootTimeoutMs: number },
) => LifecycleLike

export interface PhoneServiceDeps {
  config(): ServiceConfig
  resolveRuntime(): Promise<RuntimeHandle>
  platform(): Promise<Platform>
  connect(endpoint: Endpoint, options?: { timeoutMs?: number }): Promise<AdbConnectionLike>
  disconnect(connection: AdbConnectionLike): Promise<void>
  createDevice(connection: AdbConnectionLike): DeviceOps
  startStream(options: StreamSessionOptions): Promise<StreamSession>
  createLifecycle: CreateLifecycle
  /** 流关闭宽限期（默认 5000ms；测试注入立即执行）。 */
  schedule?(callback: () => void, delayMs: number): () => void
  /** 可注入时钟（单测验证 30s 防抖；默认 Date.now）。 */
  now?(): number
  /** 注入 sleep（单测缩短冷启动重试等待；默认 setTimeout）。 */
  sleep?(delayMs: number): Promise<void>
  /** 注入 boot 重试延迟序列（默认 bootRetryDelays(DEFAULT_BOOT_TIMEOUT_MS - 20s)）。 */
  bootRetryDelays?(): number[]
  /**
   * ADB 连通后是否继续等系统真正可用（issue #67：sys.boot_completed=1 且 package manager
   * ready）。默认关闭以保持既有单测/attach 行为；wiring 生产装配开启。
   */
  waitBootCompleted?: boolean
  /** waitBootCompleted 的超时（默认 90s）。 */
  bootReadyTimeoutMs?: number
  /** 看门狗检查间隔（issue #83；默认 2000ms）。 */
  watchdogIntervalMs?: number
  /** start/stop/restart 动作超时（issue #83；默认 180s）。 */
  actionTimeoutMs?: number
  /** dispose 总预算（issue #83；默认 5000ms）。 */
  disposeBudgetMs?: number
  /** 注入 interval（单测手动触发看门狗）。 */
  setInterval?(callback: () => void, intervalMs: number): () => void
}
