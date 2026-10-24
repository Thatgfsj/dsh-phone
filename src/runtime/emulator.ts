/**
 * emulator 适配器：用 Android SDK 的 `emulator` 可执行文件拉起 headless AVD。
 *
 * 参数来自 config.emulator：`avdName`（空则自动创建/挑第一个）、`resolution`。
 * 休眠采用 quick-boot 快照语义：pause = SIGTERM 让 emulator 退出并保存快照，
 * resume = 带 `-snapshot default_boot` 冷启动进程。**本机无 emulator 二进制，
 * 此语义未在真机验证**（见 docs/runtime.md）。
 */

import { dirname, join } from 'node:path'

import { waitUntil } from '../adb/timing.ts'
import { DEFAULT_EMULATOR_BOOT_TIMEOUT_MS, DEFAULT_RUNTIME_OPTIONS } from './types.ts'
import { RuntimeError } from './types.ts'
import { DEFAULT_ADB_HOST, DEFAULT_ADB_PORT, formatEndpoint } from './types.ts'
import type {
  CommandRunner,
  EmulatorOptions,
  Endpoint,
  RuntimeAdapter,
  RuntimeDeps,
  RuntimeEnvironment,
  RuntimeProbe,
  RuntimeStatus,
} from './types.ts'

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
  readonly #endpoint: Endpoint
  #emulatorPath: string | undefined
  #avdName: string | undefined
  #pid: number | undefined
  #since: number | undefined
  #paused = false
  #hasSnapshot = false

  constructor(options: EmulatorRuntimeOptions) {
    this.#options = options.emulator
    this.#env = options.deps.env
    this.#runner = options.deps.runner
    this.#emulatorPath = options.emulatorPath
    this.#avdName = options.emulator.avdName.trim() || undefined
    this.#endpoint = {
      host: DEFAULT_ADB_HOST,
      port: options.emulator.port ?? DEFAULT_ADB_PORT,
    }
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

  async ensureRunning(onProgress?: (message: string) => void): Promise<Endpoint> {
    if (this.#pid !== undefined && (await this.#runner.isProcessAlive(this.#pid))) {
      const ready = await this.#waitReady(onProgress)
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
    const avd = await this.#resolveAvd(emulatorPath, onProgress)
    const args = this.#buildArgs(avd)
    onProgress?.(`启动 emulator（AVD=${avd}）…`)

    const spawned = await this.#runner.spawnDetached(emulatorPath, args)
    this.#pid = spawned.pid
    this.#paused = false

    const ready = await this.#waitReady(onProgress)
    if (!ready) {
      throw this.#notReadyError()
    }
    this.#since ??= Date.now()
    onProgress?.(formatEndpoint(this.#endpoint) + ' 已就绪')
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
    return {
      kind: 'emulator',
      running: alive && !this.#paused,
      paused: this.#paused,
      endpoint: this.#endpoint,
      since: this.#since,
      pid: this.#pid,
    }
  }

  async #resolveEmulator(): Promise<string | undefined> {
    if (!this.#emulatorPath) {
      this.#emulatorPath = await this.#env.findEmulator()
    }
    return this.#emulatorPath
  }

  async #resolveAvd(
    emulatorPath: string,
    onProgress?: (message: string) => void,
  ): Promise<string> {
    if (this.#avdName) return this.#avdName
    const listed = await this.#runner.run(emulatorPath, ['-list-avds'], {
      timeoutMs: 20_000,
    })
    const first = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (first) {
      this.#avdName = first
      return first
    }
    onProgress?.('没有找到 AVD，尝试用 avdmanager 自动创建 …')
    this.#avdName = await this.#createAvd(emulatorPath)
    return this.#avdName
  }

  async #createAvd(emulatorPath: string): Promise<string> {
    const name = 'dsh-phone-avd'
    const systemImage =
      this.#options.systemImage ?? 'system-images;android-34;google_apis;x86_64'
    const sdkRoot = dirname(dirname(emulatorPath))
    const avdmanager = join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
    const result = await this.#runner.run(
      avdmanager,
      ['create', 'avd', '-n', name, '-k', systemImage, '--force'],
      { timeoutMs: 60_000 },
    )
    if (result.code !== 0) {
      throw new RuntimeError(
        `没有可用的 AVD，自动创建也失败（需要已安装 system image ${systemImage}）。` +
          '请在 Android Studio 里创建 AVD，或在 dsh-phone.emulator.avdName 填入已有 AVD 名称。' +
          `\n详细输出: ${result.stderr.trim() || result.stdout.trim()}`,
        'start',
      )
    }
    return name
  }

  #buildArgs(avd: string): string[] {
    const consolePort = Math.max(1, this.#endpoint.port - 1)
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
      String(consolePort),
    ]
    if (resolution) args.push('-skin', resolution)
    if (this.#hasSnapshot) args.push('-snapshot', 'default_boot')
    return args
  }

  async #waitReady(
    onProgress?: (message: string) => void,
    timeoutMs = this.#options.bootTimeoutMs ?? DEFAULT_EMULATOR_BOOT_TIMEOUT_MS,
  ): Promise<boolean> {
    const startedAt = Date.now()
    onProgress?.(`等待 adbd 就绪（${formatEndpoint(this.#endpoint)}，上限 ${timeoutMs}ms）…`)
    const ready = await this.#env.waitForPort(this.#endpoint, {
      timeoutMs,
      intervalMs: 500,
    })
    onProgress?.(
      ready
        ? `adbd 就绪，用时 ${Date.now() - startedAt}ms`
        : `等待超时（${timeoutMs}ms）`,
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
