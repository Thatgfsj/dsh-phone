/** 运行时/状态机单测用的假实现：命令执行器、系统环境、手动时钟。 */

import type { Clock } from '../../src/phone/idle.ts'
import type {
  CommandResult,
  CommandRunner,
  Endpoint,
  KillSignal,
  Platform,
  ProcessUsage,
  RuntimeEnvironment,
  RuntimeProbe,
  SpawnedProcess,
  WaitForPortOptions,
} from '../../src/runtime/types.ts'

export interface FakeCommandCall {
  file: string
  args: string[]
}

export type FakeHandler = (
  file: string,
  args: readonly string[],
) => CommandResult | Promise<CommandResult>

function ok(stdout = ''): CommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function fail(stderr: string, code = 1): CommandResult {
  return { code, stdout: '', stderr, timedOut: false }
}

export class FakeCommandRunner implements CommandRunner {
  readonly calls: FakeCommandCall[] = []
  readonly spawns: FakeCommandCall[] = []
  readonly kills: { pid: number; signal: KillSignal }[] = []
  readonly alive = new Set<number>()
  readonly #handlers: { match: (file: string, args: readonly string[]) => boolean; handler: FakeHandler }[] = []
  /** emulator -list-avds 返回的 AVD 列表（issue #56）。 */
  avds: string[] = ['dsh-phone-avd']
  /** spawn 后立即让进程“退出”（模拟 emulator FATAL，issue #67）。 */
  diesAfterSpawn = false
  #nextPid = 1000

  /** 注册按 (file, args) 匹配的处理函数；后注册的优先。 */
  on(
    match: string | ((file: string, args: readonly string[]) => boolean),
    handler: FakeHandler,
  ): this {
    const predicate =
      typeof match === 'string'
        ? (file: string, args: readonly string[]) => file === match
        : match
    this.#handlers.unshift({ match: predicate, handler })
    return this
  }

  /** 便捷：`docker inspect` 返回容器状态，其它 docker 命令成功。 */
  dockerInspect(status: string | undefined, id = 'cid-1'): this {
    return this.on(
      (file, args) => file === 'docker' && args[0] === 'inspect',
      () =>
        status === undefined
          ? fail('Error: No such object: dsh-phone-redroid')
          : ok(`${status}\t${id}\n`),
    )
  }

  async run(
    file: string,
    args: readonly string[],
    _options?: unknown,
  ): Promise<CommandResult> {
    this.calls.push({ file, args: [...args] })
    if (args[0] === '-list-avds') return ok(this.avds.length > 0 ? this.avds.join('\n') + '\n' : '')
    for (const entry of this.#handlers) {
      if (entry.match(file, args)) return entry.handler(file, args)
    }
    return ok()
  }

  async spawnDetached(
    file: string,
    args: readonly string[],
    _options?: unknown,
  ): Promise<SpawnedProcess> {
    this.spawns.push({ file, args: [...args] })
    const pid = this.#nextPid++
    if (!this.diesAfterSpawn) this.alive.add(pid)
    return { pid }
  }

  async kill(pid: number, signal: KillSignal = 'SIGTERM'): Promise<boolean> {
    this.kills.push({ pid, signal })
    if (!this.alive.has(pid)) return false
    if (signal !== 'SIGTERM' || true) this.alive.delete(pid)
    return true
  }

  async isProcessAlive(pid: number): Promise<boolean> {
    return this.alive.has(pid)
  }
}

export class FakeEnvironment implements RuntimeEnvironment {
  platformValue: Platform = 'linux'
  readonly paths = new Set<string>()
  readonly commands = new Set<string>()
  emulatorPath: string | undefined
  accelerationResult: RuntimeProbe = { ok: true, detail: 'fake 虚拟化可用' }
  /** waitForPort 返回 true 的端口（模拟 adbd 就绪）。 */
  readonly openPorts = new Set<number>()
  /** isPortBusy 返回 true 的端口（模拟端口已被占用，issue #56）。 */
  readonly busyPorts = new Set<number>()
  avdManagerPath: string | undefined
  processUsage: ProcessUsage = {}
  /** emulator console 认证 token（issue #67）。 */
  consoleToken: string | undefined
  /** AVD 是否已有快照（issue #67；默认 true，避免单测触发 console 保存）。 */
  hasSnapshot = true
  /** 快照是否完整（false 时模拟 snapshot.pb 被截断）。 */
  snapshotValid = true
  snapshotInvalidReason = 'snapshot.pb 仅 11 字节（写入被截断）'
  removedSnapshots = 0
  /** 启动日志尾部（模拟 emulator FATAL）。 */
  fileTail: string | undefined
  /** GPU 模式探测结果。 */
  gpuMode = 'swiftshader_indirect'

  async platform(): Promise<Platform> {
    return this.platformValue
  }

  async pathExists(path: string): Promise<boolean> {
    return this.paths.has(path)
  }

  async hasCommand(command: string): Promise<boolean> {
    return this.commands.has(command)
  }

  async findEmulator(): Promise<string | undefined> {
    return this.emulatorPath
  }

  async acceleration(): Promise<RuntimeProbe> {
    return this.accelerationResult
  }

  async waitForPort(
    endpoint: Endpoint,
    _options: WaitForPortOptions,
  ): Promise<boolean> {
    // 测试里不等真实超时：固定跳一个 tick 后按 openPorts 判断
    await new Promise<void>((resolve) => setImmediate(resolve))
    return this.openPorts.has(endpoint.port)
  }

  async isPortBusy(port: number): Promise<boolean> {
    await new Promise<void>((resolve) => setImmediate(resolve))
    return this.busyPorts.has(port)
  }

  async readEmulatorConsoleToken(): Promise<string | undefined> {
    return this.consoleToken
  }

  async hasAvdSnapshot(): Promise<boolean> {
    return this.hasSnapshot
  }

  async findAvdManager(): Promise<string | undefined> {
    return this.avdManagerPath
  }

  async sampleProcessUsage(): Promise<ProcessUsage> {
    return this.processUsage
  }

  async readFileTail(): Promise<string | undefined> {
    return this.fileTail
  }

  async inspectAvdSnapshot(): Promise<{ exists: boolean; valid: boolean; reason?: string }> {
    if (!this.hasSnapshot) return { exists: false, valid: false, reason: '快照目录不存在' }
    if (!this.snapshotValid) {
      return { exists: true, valid: false, reason: this.snapshotInvalidReason }
    }
    return { exists: true, valid: true }
  }

  async removeAvdSnapshot(): Promise<void> {
    this.removedSnapshots += 1
    this.hasSnapshot = false
    this.snapshotValid = false
  }

  emulatorLogPath(consolePort: number): string {
    return '/tmp/fake-emulator-' + consolePort + '.log'
  }

  async detectGpuMode(): Promise<string> {
    return this.gpuMode
  }
}

interface ManualTimer {
  at: number
  callback: () => void
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

export class ManualClock implements Clock {
  #now = 1_700_000_000_000
  #sequence = 1
  readonly timers = new Map<number, ManualTimer>()

  now(): number {
    return this.#now
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#sequence++
    this.timers.set(id, { at: this.#now + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  get pending(): number {
    return this.timers.size
  }

  /** 推进时钟并按时间顺序触发到点定时器（每次触发后清微任务）。 */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.#now = due[1].at
      due[1].callback()
      await flushMicrotasks()
    }
    this.#now = target
    await flushMicrotasks()
  }
}
