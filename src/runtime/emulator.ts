/**
 * emulator 适配器：用 Android SDK 的 `emulator` 可执行文件拉起 headless AVD。
 *
 * issue #56 起的健壮性：
 * - AVD：配置 avdName 优先且必须存在；自动模式只认 dsh-phone- 前缀，绝不劫持用户 AVD；
 *   avdmanager 多候选探测（cmdline-tools/{latest,各版本}/bin、SDK 根、ANDROID_HOME、PATH）。
 * - 端口：默认 console 5554 / adb 5555 被占用时向上找空闲偶数 console 端口，
 *   实际端口回写 RuntimeStatus（ensureRunning 返回的 endpoint 即实际端口）。
 * - 进度：onProgress 附带 BootPhase（launching / waiting-adbd / ready），供 /status phase。
 * - cpuPct/memPct：Linux 读 /proc/<pid>，取不到则省略（不报错）。
 *
 * 休眠采用 quick-boot 快照语义：pause = SIGTERM 让 emulator 退出并保存快照，
 * resume = 带 `-snapshot default_boot` 冷启动进程。**本机无 emulator 二进制/AVD，
 * 此语义与端口自愈未在真机验证**（见 docs/runtime.md）。
 */

import { waitUntil } from '../adb/timing.ts'
import { resolveAvd, selectEmulatorEndpoint } from './emulator-avd.ts'
import { DEFAULT_EMULATOR_BOOT_TIMEOUT_MS, DEFAULT_RUNTIME_OPTIONS } from './types.ts'
import { RuntimeError } from './types.ts'
import { DEFAULT_ADB_HOST, DEFAULT_ADB_PORT, formatEndpoint } from './types.ts'
import type {
  BootPhase,
  CommandRunner,
  EmulatorOptions,
  Endpoint,
  ProcessUsage,
  RuntimeAdapter,
  RuntimeDeps,
  RuntimeEnvironment,
  RuntimeProbe,
  RuntimeStatus,
} from './types.ts'

/** cpuPct/memPct 采样缓存（避免 /status 轮询频繁读 /proc）。 */
const USAGE_CACHE_MS = 5_000

export interface EmulatorRuntimeOptions {
  emulator: EmulatorOptions
  deps: RuntimeDeps
  /** 覆盖探测到的 emulator 可执行文件路径（测试或显式配置）。 */
  emulatorPath?: string
}

export class EmulatorRuntime implements RuntimeAdapter {
  readonly kind = 'emulator' as const
  readonly #options: EmulatorOptions
  readonly #env: RuntimeEnvironment
  readonly #runner: CommandRunner
  #endpoint: Endpoint
  #consolePort: number
  #emulatorPath: string | undefined
  #avdName: string | undefined
  #pid: number | undefined
  #since: number | undefined
  #paused = false
  #hasSnapshot = false
  #usage: ProcessUsage = {}
  #usageAt = 0

  constructor(options: EmulatorRuntimeOptions) {
    this.#options = options.emulator
    this.#env = options.deps.env
    this.#runner = options.deps.runner
    this.#emulatorPath = options.emulatorPath
    this.#avdName = options.emulator.avdName.trim() || undefined
    const adbPort = options.emulator.port ?? DEFAULT_ADB_PORT
    this.#consolePort = Math.max(1, adbPort - 1)
    this.#endpoint = { host: DEFAULT_ADB_HOST, port: adbPort }
  }

  get endpoint(): Endpoint {
    return this.#endpoint
  }

  async probe(): Promise<RuntimeProbe> {
    const emulatorPath = await this.#resolveEmulator()
    if (!emulatorPath) {
      return { ok: false, reason: '未找到 Android SDK emulator 可执行文件' }
    }
    const platform = await this.#env.platform()
    const acceleration = await this.#env.acceleration(platform, emulatorPath)
    if (!acceleration.ok) {
      return {
        ok: false,
        reason: acceleration.reason ?? '硬件虚拟化不可用',
        detail: acceleration.detail,
      }
    }
    return { ok: true, detail: `emulator=${emulatorPath}` }
  }

  async ensureRunning(
    onProgress?: (message: string, phase?: BootPhase) => void,
  ): Promise<Endpoint> {
    const report = (message: string, phase?: BootPhase) => onProgress?.(message, phase)

    if (this.#pid !== undefined && (await this.#runner.isProcessAlive(this.#pid))) {
      const ready = await this.#waitReady(report)
      if (!ready) throw this.#notReadyError()
      this.#paused = false
      return this.#endpoint
    }

    const emulatorPath = await this.#resolveEmulator()
    if (!emulatorPath) {
      throw new RuntimeError(
        '未找到 Android SDK emulator：请安装 Android Studio / SDK Emulator，或在配置里指定 emulator 路径（插件不会自动安装软件）',
        'start',
      )
    }

    const avd = await resolveAvd({
      avdName: this.#options.avdName,
      systemImage: this.#options.systemImage,
      runner: this.#runner,
      env: this.#env,
      emulatorPath,
      onProgress: (message) => report(message, 'launching'),
    })
    this.#avdName = avd.name

    // 每次冷启动都重新选端口（5554/5555 可能被其它模拟器占用）
    const selected = await selectEmulatorEndpoint(this.#env, this.#options.port)
    this.#consolePort = selected.consolePort
    this.#endpoint = selected.endpoint
    report(
      `使用 emulator console 端口 ${selected.consolePort}（adb ${formatEndpoint(selected.endpoint)}）`,
      'launching',
    )

    const args = this.#buildArgs(avd.name)
    report(`启动 emulator（AVD=${avd.name}）…`, 'launching')
    const spawned = await this.#runner.spawnDetached(emulatorPath, args)
    this.#pid = spawned.pid
    this.#paused = false
    this.#usage = {}
    this.#usageAt = 0

    const ready = await this.#waitReady(report)
    if (!ready) {
      throw this.#notReadyError()
    }
    this.#since ??= Date.now()
    report(formatEndpoint(this.#endpoint) + ' 已就绪', 'ready')
    return this.#endpoint
  }

  /** quick-boot 语义：SIGTERM 让 emulator 退出并保存快照（未验证）。 */
  async pause(): Promise<void> {
    if (this.#pid === undefined || this.#paused) return
    await this.#terminate(this.#pid)
    this.#pid = undefined
    this.#paused = true
    this.#since = undefined
    this.#hasSnapshot = true
  }

  async resume(): Promise<void> {
    await this.ensureRunning()
  }

  async stop(): Promise<void> {
    if (this.#pid !== undefined) {
      await this.#terminate(this.#pid)
      // 保留退出时保存的快照，下次启动可 quick-boot
      this.#hasSnapshot = true
    }
    this.#pid = undefined
    this.#paused = false
    this.#since = undefined
  }

  async status(): Promise<RuntimeStatus> {
    const alive =
      this.#pid !== undefined && (await this.#runner.isProcessAlive(this.#pid))
    const status: RuntimeStatus = {
      kind: 'emulator',
      running: alive && !this.#paused,
      paused: this.#paused,
      endpoint: this.#endpoint,
      since: this.#since,
      pid: this.#pid,
    }
    if (this.#pid !== undefined && alive) {
      const usage = await this.#sampleUsage(this.#pid)
      if (usage.cpuPct !== undefined) status.cpuPct = usage.cpuPct
      if (usage.memPct !== undefined) status.memPct = usage.memPct
    }
    return status
  }

  /** 尽力而为：取不到（非 Linux / 进程已退出）就省略，不影响 status。 */
  async #sampleUsage(pid: number): Promise<ProcessUsage> {
    const now = Date.now()
    if (now - this.#usageAt < USAGE_CACHE_MS) return this.#usage
    this.#usage = await this.#env.sampleProcessUsage(pid).catch(() => ({}))
    this.#usageAt = now
    return this.#usage
  }

  async #resolveEmulator(): Promise<string | undefined> {
    if (!this.#emulatorPath) {
      this.#emulatorPath = await this.#env.findEmulator()
    }
    return this.#emulatorPath
  }

  #buildArgs(avd: string): string[] {
    const resolution = this.#options.resolution.trim()
    const args = [
      '-avd',
      avd,
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-gpu',
      'swiftshader_indirect',
      '-netdelay',
      'none',
      '-netspeed',
      'full',
      '-port',
      String(this.#consolePort),
    ]
    if (resolution) args.push('-skin', resolution)
    if (this.#hasSnapshot) args.push('-snapshot', 'default_boot')
    return args
  }

  async #waitReady(
    report?: (message: string, phase?: BootPhase) => void,
    timeoutMs = this.#options.bootTimeoutMs ?? DEFAULT_EMULATOR_BOOT_TIMEOUT_MS,
  ): Promise<boolean> {
    const startedAt = Date.now()
    report?.(
      `等待 adbd 就绪（${formatEndpoint(this.#endpoint)}，上限 ${timeoutMs}ms）…`,
      'waiting-adbd',
    )
    const ready = await this.#env.waitForPort(this.#endpoint, {
      timeoutMs,
      intervalMs: 500,
    })
    report?.(
      ready ? `adbd 就绪，用时 ${Date.now() - startedAt}ms` : `等待超时（${timeoutMs}ms）`,
      ready ? 'ready' : 'waiting-adbd',
    )
    return ready
  }

  #notReadyError(): RuntimeError {
    return new RuntimeError(
      `emulator 在限定时间内未就绪（${formatEndpoint(this.#endpoint)} 不可达）：请检查 AVD 是否可启动、KVM/WHPX/HVF 是否可用`,
      'start',
    )
  }

  async #terminate(pid: number): Promise<void> {
    await this.#runner.kill(pid, 'SIGTERM')
    const exited = await waitUntil(
      async () => !(await this.#runner.isProcessAlive(pid)),
      10_000,
      250,
    )
    if (!exited) {
      await this.#runner.kill(pid, 'SIGKILL')
    }
  }
}

/** 默认 AVD 配置（宿主层可用作兜底值）。 */
export const DEFAULT_EMULATOR_OPTIONS: EmulatorOptions =
  DEFAULT_RUNTIME_OPTIONS.emulator
