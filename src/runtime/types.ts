/**
 * 运行时层类型契约（对齐 INTERFACES.md §1 与 SPEC §3.1/§3.4/§3.5）。
 *
 * 三适配器：redroid / emulator / attach；`auto` 时由 detect.ts 按决策树选择。
 */

import type { Endpoint } from '../adb/types.ts'

export type { Endpoint } from '../adb/types.ts'
export { DEFAULT_ADB_HOST, DEFAULT_ADB_PORT, formatEndpoint, parseEndpoint } from '../adb/types.ts'

export type Platform = 'linux' | 'windows' | 'macos' | 'other'
export type RuntimeKind = 'redroid' | 'emulator' | 'attach'
export type RuntimeSetting = 'auto' | RuntimeKind
export type PhoneState = 'stopped' | 'booting' | 'running' | 'paused'

/** booting 进度阶段（issue #56）：供 /status 与客户端进度层展示，向后兼容（可选）。 */
export type BootPhase =
  | 'launching'
  | 'waiting-adbd'
  | 'connecting-adb'
  | 'waiting-boot'
  | 'saving-snapshot'
  | 'ready'

export interface RuntimeProbe {
  ok: boolean
  reason?: string
  detail?: string
}

export interface RuntimeStatus {
  kind: RuntimeKind
  running: boolean
  paused: boolean
  endpoint?: Endpoint
  since?: number
  pid?: number
  containerId?: string
  /** 尽力而为的 CPU/内存占用（取不到则省略，issue #56）。 */
  cpuPct?: number
  memPct?: number
}

/** 进程/设备资源占用采样（尽力而为，字段可缺省）。 */
export interface ProcessUsage {
  cpuPct?: number
  memPct?: number
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind
  probe(): Promise<RuntimeProbe>
  /**
   * 启动实例。onProgress 的第二个参数是 boot 阶段（issue #56）：
   * 服务层据此在 /status 的 booting 状态里给出 phase，客户端展示进度层。
   */
  ensureRunning(
    onProgress?: (message: string, phase?: BootPhase) => void,
  ): Promise<Endpoint>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  status(): Promise<RuntimeStatus>
  /**
   * 启动被取消（boot 超时/规则失败）时清理半个实例，避免孤儿进程（issue #67）。
   * 可选：不实现则视为 no-op。
   */
  cancelStart?(): Promise<void>
}

/* ---------------------------------- 配置 ---------------------------------- */

export interface RedroidOptions {
  image: string
  memLimit: string
  vcpuLimit: number
  /** docker 容器名，默认 `dsh-phone-redroid`。 */
  containerName?: string
  /** 宿主侧映射端口，默认 5555。 */
  port?: number
}

export interface EmulatorOptions {
  /** 空字符串表示“首次自动创建”（SPEC §6.1）。 */
  avdName: string
  /** 形如 `720x1280`；为空则用 AVD 默认。 */
  resolution: string
  /** 宿主侧 adb 端口（默认 5555，控制台端口为 port-1）。 */
  port?: number
  /** 等待 adbd 就绪的上限，默认 120s（SPEC：emulator 冷启 20–40s）。 */
  bootTimeoutMs?: number
  /** 自动创建 AVD 时使用的 system image。 */
  systemImage?: string
}

export interface AttachOptions {
  /** 已解析的端点，如 `127.0.0.1:5555`；空表示未解析。 */
  endpoint: string
  /** 用户的一句话（原文保留，SPEC §6.2 R2）。 */
  userHint: string
  resolved: boolean
}

export interface RuntimeOptions {
  runtime: RuntimeSetting
  redroid: RedroidOptions
  emulator: EmulatorOptions
  attach: AttachOptions
}

export const DEFAULT_EMULATOR_BOOT_TIMEOUT_MS = 120_000
export const DEFAULT_REDROID_BOOT_TIMEOUT_MS = 60_000

export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = {
  runtime: 'auto',
  redroid: {
    image: 'redroid/redroid:14-latest',
    memLimit: '2g',
    vcpuLimit: 2,
  },
  emulator: { avdName: '', resolution: '720x1280' },
  attach: { endpoint: '', userHint: '', resolved: false },
}

/* --------------------------------- 宿主命令 -------------------------------- */

export interface CommandRunOptions {
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string>
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SpawnDetachedOptions {
  cwd?: string
  env?: Record<string, string>
  /** 把子进程 stdout/stderr 追加到该文件（issue #67：FATAL 可见）。 */
  logFile?: string
}

export interface SpawnedProcess {
  pid?: number
}

export type KillSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT'

/** 可注入的宿主命令执行器（单测用假实现，生产用 node:child_process）。 */
export interface CommandRunner {
  run(
    file: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>
  spawnDetached(
    file: string,
    args: readonly string[],
    options?: SpawnDetachedOptions,
  ): Promise<SpawnedProcess>
  kill(pid: number, signal?: KillSignal): Promise<boolean>
  isProcessAlive(pid: number): Promise<boolean>
}

/* --------------------------------- 环境探测 -------------------------------- */

export interface WaitForPortOptions {
  timeoutMs: number
  intervalMs?: number
}

/** 可注入的系统环境探测（单测用假实现，生产用 probe.ts）。 */
export interface RuntimeEnvironment {
  platform(): Promise<Platform>
  pathExists(path: string): Promise<boolean>
  hasCommand(command: string): Promise<boolean>
  findEmulator(): Promise<string | undefined>
  /** Linux: /dev/kvm；Windows: WHPX；macOS: Hypervisor.framework。 */
  acceleration(platform: Platform, emulatorPath?: string): Promise<RuntimeProbe>
  waitForPort(endpoint: Endpoint, options: WaitForPortOptions): Promise<boolean>
  /** 端口是否已被占用（只做一次短探测，用于选择空闲 console 端口）。 */
  isPortBusy(port: number, timeoutMs?: number): Promise<boolean>
  /**
   * 探测 avdmanager（issue #56）：cmdline-tools/{latest,各版本}/bin → SDK 根 tools/bin
   * → ANDROID_HOME/ANDROID_SDK_ROOT → PATH。取不到返回 undefined。
   */
  findAvdManager(emulatorPath?: string): Promise<string | undefined>
  /** 读取文件最后 N 行（启动失败时把 emulator FATAL 日志带给用户，issue #67）。 */
  readFileTail(path: string, lines?: number): Promise<string | undefined>
  /** 检查 AVD quick-boot 快照是否完整（snapshot.pb/ram 文件大小，issue #67）。 */
  inspectAvdSnapshot(avdName: string, snapshotName?: string): Promise<{
    exists: boolean
    valid: boolean
    reason?: string
  }>
  /** 删除损坏的 AVD 快照目录（无效快照会导致 emulator 启动失败）。 */
  removeAvdSnapshot(avdName: string, snapshotName?: string): Promise<void>
  /** 实例启动日志路径（/tmp/dsh-phone-emulator-<port>.log）。 */
  emulatorLogPath(consolePort: number): string
  /** 选择 GPU 模式（issue #67：有 Vulkan/DRM 时 angle_indirect，否则 swiftshader_indirect）。 */
  detectGpuMode(): Promise<string>
  /** 读取 ~/.emulator_console_auth_token（emulator console 认证 token；取不到 undefined）。 */
  readEmulatorConsoleToken(): Promise<string | undefined>
  /** AVD 是否已有指定名称的 quick-boot 快照（决定启动是否走快照）。 */
  hasAvdSnapshot(avdName: string, snapshotName?: string): Promise<boolean>
  /**
   * 采样宿主进程 CPU/内存占用（issue #56，仅 Linux /proc；取不到返回 {}）。
   * CPU% 需要两次采样，首次调用通常只返回 memPct。
   */
  sampleProcessUsage(pid: number): Promise<ProcessUsage>
}

export interface RuntimeDeps {
  env: RuntimeEnvironment
  runner: CommandRunner
}

/* ------------------------------- 探测决策链 ------------------------------- */

export interface DetectionStep {
  /** 决策树步骤名，如 `redroid` / `emulator` / `attach` / `fail`。 */
  step: string
  ok: boolean
  detail: string
}

export interface RuntimeDetection {
  kind: RuntimeKind
  platform: Platform
  steps: DetectionStep[]
  /** 选中原因（首个人类可读说明）。 */
  reason: string
}

/* ---------------------------------- 错误 ---------------------------------- */

export type RuntimeErrorCode =
  | 'unavailable'
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'attach-unresolved'
  | 'command'

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode

  constructor(
    message: string,
    code: RuntimeErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'RuntimeError'
    this.code = code
  }
}

/**
 * 决策树全失败：带平台安装指引（SPEC §3.1 第 4 步，禁止静默失败）。
 *
 * 签名对齐 architecture.md §3.1：`(kind, hints, cause?)`；`platform/steps` 是
 * 额外诊断信息（可选第 4 参），不改变宿主对 `kind/hints` 的用法。
 */
export class RuntimeUnavailableError extends RuntimeError {
  /** 该平台的首选运行时（决策树全失败时用来表达“首选也不可用”）。 */
  readonly kind: RuntimeKind
  /** 给工具/HTTP 直接展示的安装指引行。 */
  readonly hints: string[]
  readonly platform?: Platform
  readonly steps: DetectionStep[]

  constructor(
    kind: RuntimeKind,
    hints: string[],
    cause?: unknown,
    extra?: { platform?: Platform; steps?: DetectionStep[] },
  ) {
    super(
      `没有可用的 Android 运行时（首选 ${kind} 不可用）\n${hints.join('\n')}`,
      'unavailable',
      { cause },
    )
    this.name = 'RuntimeUnavailableError'
    this.kind = kind
    this.hints = hints
    this.platform = extra?.platform
    this.steps = extra?.steps ?? []
  }
}
