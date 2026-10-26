/**
 * emulator 适配器：用 Android SDK 的 emulator 可执行文件拉起 headless AVD。
 *
 * issue #56 健壮性：AVD 安全选择、avdmanager 多候选、空闲端口、cpuPct/memPct、BootPhase。
 * issue #67 启动性能/稳定性：
 * - quick-boot 快照：启动带 -snapshot default_boot（不传 -no-snapshot-save）；首次成功后用
 *   emulator console 主动保存并校验完整性（snapshot.pb 被截断 → 删除回退冷启动）；
 * - pause/stop：先 console 保存 + 校验，再 SIGTERM，最多等 120s（不再 10s SIGKILL 截断快照）；
 * - 同 AVD 已在运行 → adopt 复用（不再 spawn 第二实例，避免 multi-instance FATAL）；
 * - spawn 日志落盘（/tmp/dsh-phone-emulator-<port>.log），进程早退时把日志尾部带给用户；
 * - 调优 flag：-no-boot-anim/-no-audio/-gpu(自动)/-memory/-cores/-no-metrics/-camera none；
 *   仅当用户显式改过 resolution（非默认 720x1280）时才传 -skin，避免覆盖 AVD skin/density；
 * - cancelStart：boot 超时/取消时清理自己 spawn 的半启动实例（adopt 的用户实例不动）。
 */

import { waitUntil } from '../adb/timing.ts'
import { runEmulatorConsoleCommand } from './emulator-console.ts'
import type { ConsoleCommandResult } from './emulator-console.ts'
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

const USAGE_CACHE_MS = 5_000
export const EMULATOR_SNAPSHOT_NAME = 'default_boot'
export const DEFAULT_EMULATOR_MEMORY_MB = 2048
export const DEFAULT_EMULATOR_CORES = 4
/** 配置默认分辨率：等于它说明用户没显式指定，不用 -skin 覆盖 AVD 自身 skin/density。 */
export const DEFAULT_EMULATOR_RESOLUTION = '720x1280'
const ADBD_POLL_INTERVAL_MS = 250
const SNAPSHOT_SAVE_TIMEOUT_MS = 120_000
const SNAPSHOT_VALIDATE_TIMEOUT_MS = 30_000
const TERMINATE_TIMEOUT_MS = 120_000

export interface EmulatorRuntimeOptions {
  emulator: EmulatorOptions
  deps: RuntimeDeps
  /** 覆盖探测到的 emulator 可执行文件路径（测试或显式配置）。 */
  emulatorPath?: string
  memoryMb?: number
  cores?: number
  /** 覆盖 GPU 模式（默认按 env.detectGpuMode()）。 */
  gpuMode?: string
  /** 是否复用同 AVD 已运行实例（默认 true；单测通常关闭）。 */
  adoptRunning?: boolean
  /** 注入 console 命令（测试用；默认走 emulator-console 客户端）。 */
  consoleCommand?: (command: string, authToken?: string) => Promise<ConsoleCommandResult>
}

interface RunningEmulator {
  pid: number
  consolePort: number
}

function sleep(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    timer.unref?.()
  })
}

export class EmulatorRuntime implements RuntimeAdapter {
  readonly kind = 'emulator' as const
  readonly #options: EmulatorOptions
  readonly #env: RuntimeEnvironment
  readonly #runner: CommandRunner
  readonly #adoptRunning: boolean
  readonly #gpuModeOverride: string | undefined
  readonly #memoryMb: number
  readonly #cores: number
  readonly #consoleCommand: (command: string, authToken?: string) => Promise<ConsoleCommandResult>
  #endpoint: Endpoint
  #consolePort: number
  #gpuMode: string | undefined
  #emulatorPath: string | undefined
  #avdName: string | undefined
  #pid: number | undefined
  #since: number | undefined
  #paused = false
  #adopted = false
  #snapshotSaved = false
  #cancelRequested = false
  #usage: ProcessUsage = {}
  #usageAt = 0

  constructor(options: EmulatorRuntimeOptions) {
    this.#options = options.emulator
    this.#env = options.deps.env
    this.#runner = options.deps.runner
    this.#adoptRunning = options.adoptRunning !== false
    this.#gpuModeOverride = options.gpuMode
    this.#emulatorPath = options.emulatorPath
    this.#avdName = options.emulator.avdName.trim() || undefined
    this.#memoryMb = options.memoryMb ?? DEFAULT_EMULATOR_MEMORY_MB
    this.#cores = options.cores ?? DEFAULT_EMULATOR_CORES
    this.#consoleCommand =
      options.consoleCommand ??
      ((command, authToken) =>
        runEmulatorConsoleCommand({
          port: this.#consolePort,
          command: command,
          authToken: authToken,
          timeoutMs: SNAPSHOT_SAVE_TIMEOUT_MS,
        }))
    const adbPort = options.emulator.port ?? DEFAULT_ADB_PORT
    this.#consolePort = Math.max(1, adbPort - 1)
    this.#endpoint = { host: DEFAULT_ADB_HOST, port: adbPort }
  }

  get endpoint(): Endpoint {
    return this.#endpoint
  }

  get adopted(): boolean {
    return this.#adopted
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
    return { ok: true, detail: 'emulator=' + emulatorPath }
  }

  async ensureRunning(
    onProgress?: (message: string, phase?: BootPhase) => void,
  ): Promise<Endpoint> {
    const report = (message: string, phase?: BootPhase) => onProgress?.(message, phase)
    this.#cancelRequested = false

    if (this.#pid !== undefined && (await this.#runner.isProcessAlive(this.#pid))) {
      const ready = await this.#waitReady(report)
      if (!ready) throw await this.#startupFailure('emulator 进程存在但 adbd 端口未就绪')
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
      emulatorPath: emulatorPath,
      onProgress: (message) => report(message, 'launching'),
    })
    this.#avdName = avd.name

    // issue #67：同 AVD 已在运行 → 复用，避免 multi-instance FATAL / 再开一台
    if (this.#adoptRunning) {
      const adopted = await this.#tryAdopt(avd.name)
      if (adopted) {
        this.#pid = adopted.pid
        this.#consolePort = adopted.consolePort
        this.#endpoint = { host: DEFAULT_ADB_HOST, port: adopted.consolePort + 1 }
        this.#adopted = true
        this.#snapshotSaved = true
        report(
          '复用已在运行的 emulator（AVD=' + avd.name + '，pid=' + adopted.pid + '，adb=' +
            formatEndpoint(this.#endpoint) + '）',
          'launching',
        )
        const ready = await this.#waitReady(report)
        if (!ready) throw await this.#startupFailure('已运行的 emulator 端口不可达')
        this.#paused = false
        report(formatEndpoint(this.#endpoint) + ' 已就绪（复用）', 'ready')
        return this.#endpoint
      }
    }

    // issue #67：快照完整性自检；损坏（pause 被截断）则删除，回退冷启动
    const snapshot = await this.#env
      .inspectAvdSnapshot(avd.name, EMULATOR_SNAPSHOT_NAME)
      .catch(() => ({ exists: false, valid: false, reason: undefined as string | undefined }))
    if (snapshot.exists && !snapshot.valid) {
      report(
        '发现损坏的 quick-boot 快照（' + (snapshot.reason ?? '未知原因') + '），删除后冷启动 …',
        'launching',
      )
      await this.#env.removeAvdSnapshot(avd.name, EMULATOR_SNAPSHOT_NAME).catch(() => undefined)
    }
    this.#snapshotSaved = snapshot.exists && snapshot.valid
    report(
      this.#snapshotSaved
        ? '检测到有效 quick-boot 快照，尝试快照启动 …'
        : '未检测到有效快照，本次为冷启动 …',
      'launching',
    )

    const selected = await selectEmulatorEndpoint(this.#env, this.#options.port)
    this.#consolePort = selected.consolePort
    this.#endpoint = selected.endpoint
    report(
      '使用 emulator console 端口 ' + selected.consolePort + '（adb ' + formatEndpoint(selected.endpoint) + '）',
      'launching',
    )

    const args = await this.#buildArgs(avd.name)
    const logFile = this.#env.emulatorLogPath(this.#consolePort)
    report('启动 emulator（AVD=' + avd.name + '）…', 'launching')
    const spawned = await this.#runner.spawnDetached(emulatorPath, args, { logFile: logFile })
    this.#pid = spawned.pid
    this.#paused = false
    this.#adopted = false
    this.#usage = {}
    this.#usageAt = 0

    const ready = await this.#waitReady(report)
    if (!ready) throw await this.#startupFailure('emulator 启动后 adbd 端口未就绪')
    this.#since ??= Date.now()
    if (!this.#snapshotSaved) {
      await this.#saveSnapshot(report)
    }
    if (this.#cancelRequested) {
      throw new RuntimeError('启动已取消', 'start')
    }
    report(formatEndpoint(this.#endpoint) + ' 已就绪', 'ready')
    return this.#endpoint
  }

  /** quick-boot：先 console 保存并校验快照，再优雅 SIGTERM。 */
  async pause(): Promise<void> {
    if (this.#pid === undefined || this.#paused) return
    if (this.#adopted) {
      // 用户自己的实例：只断开，不暂停/不杀
      this.#paused = true
      this.#since = undefined
      return
    }
    await this.#saveSnapshot()
    await this.#terminate(this.#pid)
    this.#pid = undefined
    this.#paused = true
    this.#since = undefined
  }

  async resume(): Promise<void> {
    await this.ensureRunning()
  }

  async stop(): Promise<void> {
    if (this.#pid !== undefined && !this.#adopted) {
      await this.#saveSnapshot()
      await this.#terminate(this.#pid)
    }
    this.#pid = undefined
    this.#paused = false
    this.#since = undefined
  }

  /** boot 超时/取消：清理自己 spawn 的实例（adopt 的用户实例不动）。 */
  async cancelStart(): Promise<void> {
    this.#cancelRequested = true
    if (this.#pid === undefined || this.#adopted) return
    await this.#saveSnapshot()
    await this.#terminate(this.#pid)
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
      owned: !this.#adopted,
      adopted: this.#adopted,
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

  /**
   * 看门狗用（issue #83）：owned 用 pid 存活判断（booting 期端口未起也算活）；
   * adopted 用端口/adb（不碰用户进程）。
   */
  async isAlive(): Promise<boolean> {
    if (this.#adopted) {
      return this.#env.waitForPort(this.#endpoint, { timeoutMs: 300 }).catch(() => false)
    }
    const pid = this.#pid
    if (pid === undefined) return false
    return this.#runner.isProcessAlive(pid).catch(() => false)
  }

  async #sampleUsage(pid: number): Promise<ProcessUsage> {
    const now = Date.now()
    if (now - this.#usageAt < USAGE_CACHE_MS) return this.#usage
    this.#usage = await this.#env.sampleProcessUsage(pid).catch(() => ({}))
    this.#usageAt = now
    return this.#usage
  }

  /**
   * 查找同 AVD 已运行的 emulator（issue #67）：解析 ps 里的 qemu -avd <name> -port N。
   * 找到且端口可达 → 复用；找到但端口未就绪 → 明确报错，避免再开第二实例。
   */
  async #tryAdopt(avdName: string): Promise<RunningEmulator | undefined> {
    const platform = await this.#env.platform()
    if (platform !== 'linux' && platform !== 'macos') return undefined
    const result = await this.#runner
      .run('ps', ['-Ao', 'pid=,args='], { timeoutMs: 5_000 })
      .catch(() => undefined)
    if (!result || result.code !== 0) return undefined
    const needle = '-avd ' + avdName
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.includes(needle) || !line.includes('qemu-system')) continue
      const pidMatch = /^\s*(\d+)\s+/.exec(line)
      const portMatch = /-port\s+(\d+)/.exec(line)
      if (!pidMatch || !portMatch) continue
      const pid = Number(pidMatch[1])
      if (pid === this.#pid) continue
      const consolePort = Number(portMatch[1])
      const adbEndpoint = { host: DEFAULT_ADB_HOST, port: consolePort + 1 }
      const reachable = await this.#env.waitForPort(adbEndpoint, { timeoutMs: 2_000 })
      if (!reachable) {
        throw new RuntimeError(
          '同一个 AVD（' + avdName + '）已有进程在启动/运行中（pid=' + pid + '，console=' +
            consolePort + '），但 adb 端口暂不可达；请等待其就绪或先关闭该实例，避免 multi-instance FATAL。',
          'start',
        )
      }
      return { pid: pid, consolePort: consolePort }
    }
    return undefined
  }

  async #resolveEmulator(): Promise<string | undefined> {
    if (!this.#emulatorPath) {
      this.#emulatorPath = await this.#env.findEmulator()
    }
    return this.#emulatorPath
  }

  /** GPU 模式：默认按宿主能力（有 DRM → angle_indirect），可被 options 覆盖。 */
  async #resolveGpuMode(): Promise<string> {
    if (this.#gpuModeOverride) return this.#gpuModeOverride
    if (!this.#gpuMode) {
      this.#gpuMode = await this.#env.detectGpuMode().catch(() => 'swiftshader_indirect')
    }
    return this.#gpuMode
  }

  async #buildArgs(avd: string): Promise<string[]> {
    const gpuMode = await this.#resolveGpuMode()
    const resolution = this.#options.resolution.trim()
    const args = [
      '-avd', avd,
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-gpu', gpuMode,
      '-netdelay', 'none',
      '-netspeed', 'full',
      '-memory', String(this.#memoryMb),
      '-cores', String(this.#cores),
      '-camera-back', 'none',
      '-camera-front', 'none',
      '-no-metrics',
      '-port', String(this.#consolePort),
      '-snapshot', EMULATOR_SNAPSHOT_NAME,
    ]
    // 只有用户显式改过 resolution 才覆盖 skin（默认值不覆盖，避免改坏 AVD density/skin）
    if (resolution && resolution !== DEFAULT_EMULATOR_RESOLUTION) {
      args.push('-skin', resolution)
    }
    return args
  }

  async #waitReady(
    report?: (message: string, phase?: BootPhase) => void,
    timeoutMs = this.#options.bootTimeoutMs ?? DEFAULT_EMULATOR_BOOT_TIMEOUT_MS,
  ): Promise<boolean> {
    const startedAt = Date.now()
    report?.(
      '等待 adbd 就绪（' + formatEndpoint(this.#endpoint) + '，上限 ' + timeoutMs + 'ms）…',
      'waiting-adbd',
    )
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.#env.waitForPort(this.#endpoint, { timeoutMs: ADBD_POLL_INTERVAL_MS * 2 })) {
        report?.('adbd 就绪，用时 ' + (Date.now() - startedAt) + 'ms', 'waiting-adbd')
        return true
      }
      if (this.#cancelRequested) return false
      const pid = this.#pid
      if (pid !== undefined && !(await this.#runner.isProcessAlive(pid))) {
        return false
      }
      await sleep(ADBD_POLL_INTERVAL_MS)
    }
    return false
  }

  /** 启动失败：把 emulator 日志尾部（FATAL 通常在最后）带给用户，避免盲等 120s。 */
  async #startupFailure(summary: string): Promise<RuntimeError> {
    const logPath = this.#env.emulatorLogPath(this.#consolePort)
    const tail = await this.#env.readFileTail(logPath, 25).catch(() => undefined)
    const hint = tail && tail.trim().length > 0 ? '\n最近 emulator 日志:\n' + tail.trim() : ''
    return new RuntimeError(
      summary + '：请检查 AVD 是否可启动、KVM/WHPX/HVF 是否可用、是否有同 AVD 实例冲突。' +
        (logPath ? '（日志: ' + logPath + '）' : '') + hint,
      'start',
    )
  }

  /**
   * 保存 quick-boot 快照并校验（issue #67）：console 保存 → 轮询 snapshot.pb 完整性。
   * 失败不影响主流程（SIGTERM 退出保存兜底），但会记录原因。
   */
  async #saveSnapshot(
    report?: (message: string, phase?: BootPhase) => void,
  ): Promise<boolean> {
    if (this.#snapshotSaved) return true
    const startedAt = Date.now()
    report?.('保存 quick-boot 快照 ' + EMULATOR_SNAPSHOT_NAME + ' …', 'saving-snapshot')
    try {
      const authToken = await this.#env.readEmulatorConsoleToken().catch(() => undefined)
      const result = await this.#consoleCommand(
        'avd snapshot save ' + EMULATOR_SNAPSHOT_NAME,
        authToken,
      )
      if (!result.ok) {
        report?.('快照保存失败（将依赖退出时保存）: ' + (result.error ?? 'console 返回失败'))
        return false
      }
      const avdName = this.#avdName
      if (!avdName) return false
      const valid = await waitUntil(
        async () => {
          const snapshot = await this.#env
            .inspectAvdSnapshot(avdName, EMULATOR_SNAPSHOT_NAME)
            .catch(() => ({ exists: false, valid: false, reason: undefined as string | undefined }))
          return snapshot.valid
        },
        SNAPSHOT_VALIDATE_TIMEOUT_MS,
        500,
      )
      if (!valid) {
        report?.('快照保存后校验未通过（snapshot.pb 未稳定），下次启动将回退冷启动')
        return false
      }
      this.#snapshotSaved = true
      report?.('快照已保存并校验，用时 ' + (Date.now() - startedAt) + 'ms', 'saving-snapshot')
      return true
    } catch (error) {
      report?.(
        '快照保存失败（将依赖退出时保存）: ' +
          (error instanceof Error ? error.message : String(error)),
      )
      return false
    }
  }

  /** 优雅停止：SIGTERM launcher → 等待（默认 120s，不提前 SIGKILL 截断快照）→ SIGKILL 兜底。 */
  async #terminate(pid: number): Promise<void> {
    const signalled = await this.#runner.kill(pid, 'SIGTERM')
    if (!signalled) return
    const exited = await waitUntil(
      async () => !(await this.#runner.isProcessAlive(pid)),
      TERMINATE_TIMEOUT_MS,
      500,
    )
    if (!exited) {
      await this.#runner.kill(pid, 'SIGKILL')
    }
  }
}

export const DEFAULT_EMULATOR_OPTIONS: EmulatorOptions = DEFAULT_RUNTIME_OPTIONS.emulator
