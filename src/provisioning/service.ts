/**
 * 一键准备运行环境（issue #65）。
 *
 * 状态机：idle → running（precheck → install → licenses → avd / verify）→ done|failed。
 * - 仅由浏览器同源请求触发（HTTP 层保证）；agent token 不允许自动装软件；
 * - 只执行白名单命令（参数固定，不接受用户拼接）；15 分钟总超时；
 * - 幂等：running 时返回当前状态；done 且 runtime 相同直接返回；
 * - 失败保留最近日志与 error，可重试（再次 POST 重新开跑）；
 * - 不安装 Docker、不修改用户其它 AVD；redroid/attach 只检查并给手动命令/校验。
 */
import { AVD_NAME, emulatorCommands, redroidCommands } from '../runtime/install-guide.ts'
import {
  avdCreateCommand,
  avdListCommand,
  locateSdkTools,
  outputToLogLines,
  parseProgressPercent,
  sdkmanagerInstallCommand,
  sdkmanagerLicensesCommand,
  trimLog,
} from './commands.ts'
import type { CommandSpec, SdkTools } from './commands.ts'
import type {
  ProvisionDeps,
  ProvisionImage,
  ProvisionRequest,
  ProvisionRuntime,
  ProvisionState,
  ProvisionStatus,
  ProvisionerLike,
} from './types.ts'
import {
  MIN_FREE_DISK_BYTES,
  PROVISION_TIMEOUT_MS,
  PROVISION_LOG_LIMIT,
  isProvisionRuntime,
} from './types.ts'

class ProvisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProvisionError'
  }
}

interface Stage {
  step: string
  start: number
  end: number
  estimateMs: number
  startedAt: number
}

const STAGE_PRECHECK: Omit<Stage, 'startedAt'> = { step: 'precheck', start: 0, end: 5, estimateMs: 2_000 }
const STAGE_LOCATE: Omit<Stage, 'startedAt'> = { step: 'locate', start: 5, end: 10, estimateMs: 3_000 }
const STAGE_INSTALL: Omit<Stage, 'startedAt'> = { step: 'install', start: 10, end: 70, estimateMs: 6 * 60_000 }
const STAGE_LICENSES: Omit<Stage, 'startedAt'> = { step: 'licenses', start: 70, end: 80, estimateMs: 60_000 }
const STAGE_AVD: Omit<Stage, 'startedAt'> = { step: 'avd', start: 80, end: 100, estimateMs: 60_000 }
const STAGE_VERIFY: Omit<Stage, 'startedAt'> = { step: 'verify', start: 10, end: 100, estimateMs: 30_000 }

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

export class Provisioner implements ProvisionerLike {
  readonly #deps: ProvisionDeps
  readonly #now: () => number
  #state: ProvisionState = 'idle'
  #step = 'idle'
  #percent = 0
  #log: string[] = []
  #error: string | undefined
  #runtime: ProvisionRuntime | undefined
  #image: ProvisionImage | undefined
  #stage: Stage | undefined
  #deadline = 0
  #job: Promise<void> | undefined
  #disposed = false

  constructor(deps: ProvisionDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => Date.now())
  }

  /** GET /provision：任何时刻都可调；running 时按阶段估算插值。 */
  status(): ProvisionStatus {
    const status: ProvisionStatus = {
      state: this.#state,
      step: this.#step,
      percent: this.#percent,
      log: [...this.#log],
    }
    if (this.#error !== undefined) status.error = this.#error
    if (this.#runtime !== undefined) status.runtime = this.#runtime
    return status
  }

  /**
   * POST /provision：幂等 + 并发互斥。
   * - running → 返回当前状态（不排队、不重复执行）
   * - done 且 runtime 相同 → 直接返回
   * - failed / done 换 runtime → 重新开跑
   */
  start(request: ProvisionRequest): ProvisionStatus {
    if (!isProvisionRuntime(request.runtime)) {
      throw new ProvisionError('runtime 必须是 emulator/redroid/attach')
    }
    if (this.#state === 'running') return this.status()
    if (this.#state === 'done' && this.#runtime === request.runtime) return this.status()
    this.#prepare(request)
    this.#job = this.#run(request)
      .catch((error: unknown) => this.#fail(error))
      .finally(() => {
        this.#job = undefined
      })
    return this.status()
  }

  /** 插件卸载：标记中止；正在执行的命令由其 timeout 自行结束。 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#state === 'running') {
      this.#error = '插件已卸载，准备任务中止'
      this.#state = 'failed'
      this.#step = 'failed'
      this.#append('插件已卸载，准备任务中止')
    }
  }

  /* --------------------------------- 内部状态机 --------------------------------- */

  #prepare(request: ProvisionRequest): void {
    this.#state = 'running'
    this.#step = 'precheck'
    this.#percent = 0
    this.#log = []
    this.#error = undefined
    this.#runtime = request.runtime
    this.#image = request.image
    this.#deadline = this.#now() + PROVISION_TIMEOUT_MS
    this.#stage = undefined
    this.#append(
      '开始准备 ' + request.runtime + (request.image ? '（image=' + request.image + '）' : ''),
    )
    this.#setStage(STAGE_PRECHECK)
  }

  async #run(request: ProvisionRequest): Promise<void> {
    if (request.runtime === 'emulator') await this.#provisionEmulator()
    else if (request.runtime === 'redroid') await this.#provisionRedroid()
    else await this.#provisionAttach()
    this.#finish()
  }

  async #provisionEmulator(): Promise<void> {
    this.#assertAlive()
    const platform = await this.#deps.platform()
    this.#append('宿主平台: ' + platform)

    this.#setStage(STAGE_LOCATE)
    const tools = await locateSdkTools(this.#deps)
    if (!tools) {
      this.#append('未找到 Android SDK cmdline-tools（sdkmanager/avdmanager）')
      for (const command of emulatorCommands(platform)) {
        this.#append('手动命令: ' + command.command)
      }
      throw new ProvisionError(
        '未找到 Android SDK cmdline-tools（sdkmanager/avdmanager）。请先安装 Android Studio / cmdline-tools；' +
          '插件不会安装 Android Studio 本体（手动命令已写入日志）。',
      )
    }
    this.#append('SDK 工具: ' + tools.sdkmanager)

    // 已装好（AVD 存在）→ 快速 done，不重跑下载
    if (await this.#avdExists(tools)) {
      this.#append('已存在 AVD ' + AVD_NAME + '，跳过安装与创建')
      this.#percent = 100
      return
    }

    this.#setStage(STAGE_PRECHECK)
    const free = await this.#deps.freeDiskBytes()
    this.#append('磁盘可用空间: ' + (free / 1024 / 1024 / 1024).toFixed(1) + 'GB（要求 ≥3GB）')
    if (free < MIN_FREE_DISK_BYTES) {
      throw new ProvisionError(
        '磁盘可用空间不足（<3GB），无法安装 emulator + system image；请清理磁盘后重试',
      )
    }

    this.#assertAlive()
    this.#setStage(STAGE_INSTALL)
    const install = await this.#runCommand(sdkmanagerInstallCommand(tools, this.#image))
    const parsed = parseProgressPercent(install.stdout)
    if (parsed !== undefined) this.#append('sdkmanager 进度: ' + parsed + '%')

    this.#assertAlive()
    this.#setStage(STAGE_LICENSES)
    await this.#runCommand(sdkmanagerLicensesCommand(tools, platform))

    this.#assertAlive()
    this.#setStage(STAGE_AVD)
    if (!(await this.#avdExists(tools))) {
      await this.#runCommand(avdCreateCommand(tools, this.#image))
    } else {
      this.#append('AVD ' + AVD_NAME + ' 已存在，跳过创建')
    }
  }

  async #provisionRedroid(): Promise<void> {
    this.#assertAlive()
    this.#setStage(STAGE_VERIFY)
    this.#append('检查 Docker 与 binder（插件不会安装 Docker）')
    const docker = await this.#deps.runner.run('docker', ['version'], { timeoutMs: 20_000 })
    const binder = await this.#deps.pathExists('/dev/binder')
    const dockerOk = docker.code === 0
    this.#append('docker: ' + (dockerOk ? '可用' : '不可用') + '，/dev/binder: ' + (binder ? '存在' : '缺失'))
    if (dockerOk && binder) {
      this.#percent = 100
      return
    }
    for (const command of redroidCommands()) {
      this.#append('手动命令: ' + command.command)
    }
    throw new ProvisionError(
      'redroid 需要可用的 Docker 与 /dev/binder；插件不会自动安装 Docker（手动命令已写入日志）',
    )
  }

  async #provisionAttach(): Promise<void> {
    this.#assertAlive()
    this.#setStage(STAGE_VERIFY)
    const endpoint = this.#deps.getAttachEndpoint().trim()
    if (!endpoint) {
      throw new ProvisionError('未配置 attach.endpoint：请先在设置页填写，或让 Agent 完成接入（R5）')
    }
    this.#append('校验 attach 端点 ' + endpoint)
    const result = await this.#deps.verifyEndpoint(endpoint)
    if (!result.ok) {
      throw new ProvisionError(
        'attach 端点不可达: ' + (result.error ?? '连接失败') + '（不会修改配置）',
      )
    }
    this.#append('attach 端点可连接' + (result.banner ? '：' + result.banner : ''))
    this.#percent = 100
  }

  /* ---------------------------------- 命令执行 ---------------------------------- */

  async #runCommand(spec: CommandSpec): Promise<{ stdout: string; stderr: string }> {
    this.#assertAlive()
    const remaining = this.#deadline - this.#now()
    if (remaining <= 0) throw new ProvisionError('准备超时（15 分钟），已中止')
    this.#append('$ ' + spec.display)
    const result = await this.#deps.runner.run(spec.file, spec.args, {
      timeoutMs: Math.min(spec.timeoutMs, remaining),
    })
    for (const line of outputToLogLines(result.stdout)) this.#append(line)
    if (result.timedOut) {
      for (const line of outputToLogLines(result.stderr)) this.#append(line)
      throw new ProvisionError('命令超时: ' + spec.display)
    }
    if (result.code !== 0) {
      for (const line of outputToLogLines(result.stderr, 20)) this.#append(line)
      throw new ProvisionError('命令失败（exit ' + String(result.code) + '）: ' + spec.display)
    }
    this.#percent = this.#stage ? this.#stage.end : this.#percent
    return { stdout: result.stdout, stderr: result.stderr }
  }

  async #avdExists(tools: SdkTools): Promise<boolean> {
    try {
      const result = await this.#deps.runner.run(tools.avdmanager, avdListCommand(tools).args, {
        timeoutMs: 30_000,
      })
      if (result.code !== 0) {
        this.#append('警告: avdmanager list avd 失败，按“未安装”继续')
        return false
      }
      return result.stdout.includes(AVD_NAME)
    } catch {
      return false
    }
  }

  /* ---------------------------------- 进度与收尾 ---------------------------------- */

  #setStage(template: Omit<Stage, 'startedAt'>): void {
    this.#stage = { ...template, startedAt: this.#now() }
    this.#step = template.step
    this.#percent = clampPercent(template.start)
  }

  #finish(): void {
    if (this.#disposed) return
    this.#stage = undefined
    this.#state = 'done'
    this.#step = 'done'
    this.#percent = 100
    this.#append('准备完成')
  }

  #fail(error: unknown): void {
    if (this.#disposed) return
    const message = error instanceof Error ? error.message : String(error)
    this.#stage = undefined
    this.#state = 'failed'
    this.#step = 'failed'
    this.#error = message
    this.#append('失败: ' + message)
  }

  #append(line: string): void {
    this.#log.push(line)
    this.#log = trimLog(this.#log)
    const stage = this.#stage
    if (stage && this.#state === 'running') {
      const elapsed = Math.max(0, this.#now() - stage.startedAt)
      const ratio = stage.estimateMs <= 0 ? 1 : Math.min(1, elapsed / stage.estimateMs)
      const interpolated = Math.round(stage.start + (stage.end - stage.start) * ratio)
      const capped = Math.max(stage.start, Math.min(stage.end, interpolated))
      if (capped > this.#percent) this.#percent = clampPercent(capped)
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new ProvisionError('插件已卸载，准备任务中止')
  }
}

export { ProvisionError, PROVISION_LOG_LIMIT }
