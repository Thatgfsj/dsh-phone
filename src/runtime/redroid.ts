/**
 * redroid 适配器：用宿主 docker CLI 管理 redroid 容器实例。
 *
 * 生命周期（SPEC §3.5）：
 * - running  ← `docker run` / `docker start` / `docker unpause`
 * - paused   ← `docker pause`（内存保留、CPU 归零，恢复亚秒级）
 * - stopped  ← `docker stop`（保留容器，下次 start 复用数据）
 *
 * **本机没有 Docker，只做了假 CLI 单测，未在真实 redroid 上验证**（见 docs/runtime.md）。
 */

import { DEFAULT_REDROID_BOOT_TIMEOUT_MS, DEFAULT_RUNTIME_OPTIONS } from './types.ts'
import { RuntimeError } from './types.ts'
import { DEFAULT_ADB_HOST, DEFAULT_ADB_PORT, formatEndpoint } from './types.ts'
import type {
  BootPhase,
  CommandResult,
  CommandRunner,
  Endpoint,
  ProcessUsage,
  RedroidOptions,
  RuntimeAdapter,
  RuntimeDeps,
  RuntimeEnvironment,
  RuntimeProbe,
  RuntimeStatus,
} from './types.ts'

const INSPECT_FORMAT = '{{.State.Status}}\t{{.Id}}'
const DOCKER_TIMEOUT_MS = 120_000

export interface RedroidRuntimeOptions {
  redroid: RedroidOptions
  deps: RuntimeDeps
}

interface ContainerInfo {
  status: string
  id: string
}

const USAGE_CACHE_MS = 5_000

export class RedroidRuntime implements RuntimeAdapter {
  readonly kind = 'redroid' as const
  readonly #options: RedroidOptions
  readonly #env: RuntimeEnvironment
  readonly #runner: CommandRunner
  readonly #name: string
  readonly #endpoint: Endpoint
  #since: number | undefined
  #containerId: string | undefined
  #usage: ProcessUsage = {}
  #usageAt = 0

  constructor(options: RedroidRuntimeOptions) {
    this.#options = options.redroid
    this.#env = options.deps.env
    this.#runner = options.deps.runner
    this.#name = options.redroid.containerName ?? 'dsh-phone-redroid'
    this.#endpoint = {
      host: DEFAULT_ADB_HOST,
      port: options.redroid.port ?? DEFAULT_ADB_PORT,
    }
  }

  get endpoint(): Endpoint {
    return this.#endpoint
  }

  get containerName(): string {
    return this.#name
  }

  async probe(): Promise<RuntimeProbe> {
    if (!(await this.#env.hasCommand('docker'))) {
      return { ok: false, reason: '未找到 docker CLI' }
    }
    const platform = await this.#env.platform()
    if (platform !== 'linux') {
      return { ok: false, reason: `平台为 ${platform}，redroid 仅支持 Linux` }
    }
    if (!(await this.#env.pathExists('/dev/binder'))) {
      return {
        ok: false,
        reason: '缺少 /dev/binder（需加载 binder_linux 模块）',
      }
    }
    return { ok: true, detail: `镜像 ${this.#options.image}` }
  }

  async ensureRunning(
    onProgress?: (message: string, phase?: BootPhase) => void,
  ): Promise<Endpoint> {
    const info = await this.#inspect()
    if (!info) {
      onProgress?.(`创建 redroid 容器（${this.#options.image}）…`, 'launching')
      await this.#create()
    } else if (info.status === 'paused') {
      onProgress?.('unpause redroid 容器 …', 'launching')
      await this.#docker(['unpause', this.#name])
    } else if (info.status !== 'running') {
      onProgress?.(`启动已存在的 redroid 容器（当前 ${info.status}）…`, 'launching')
      await this.#docker(['start', this.#name])
    } else {
      onProgress?.('redroid 容器已在运行', 'launching')
    }

    const ready = await this.#waitReady(onProgress)
    if (!ready) {
      throw new RuntimeError(
        `redroid 在限定时间内 adbd 未就绪（${formatEndpoint(this.#endpoint)} 不可达）：请确认 binder 模块已加载，并查看 docker logs ${this.#name}`,
        'start',
      )
    }
    this.#since ??= Date.now()
    onProgress?.(formatEndpoint(this.#endpoint) + ' 已就绪', 'ready')
    return this.#endpoint
  }

  async pause(): Promise<void> {
    const info = await this.#inspect()
    if (!info || info.status !== 'running') return
    await this.#docker(['pause', this.#name])
    this.#since = undefined
  }

  async resume(): Promise<void> {
    const info = await this.#inspect()
    if (!info) {
      await this.ensureRunning()
      return
    }
    if (info.status === 'paused') {
      await this.#docker(['unpause', this.#name])
    } else if (info.status !== 'running') {
      await this.#docker(['start', this.#name])
    }
    const ready = await this.#waitReady()
    if (!ready) {
      throw new RuntimeError(
        `redroid 唤醒后 adbd 未就绪（${formatEndpoint(this.#endpoint)} 不可达）`,
        'resume',
      )
    }
    this.#since ??= Date.now()
  }

  async stop(): Promise<void> {
    const info = await this.#inspect()
    if (!info) return
    if (info.status === 'running' || info.status === 'paused') {
      await this.#docker(['stop', '-t', '10', this.#name])
    }
    this.#since = undefined
  }

  async status(): Promise<RuntimeStatus> {
    const info = await this.#inspect()
    this.#containerId = info?.id
    const status: RuntimeStatus = {
      kind: 'redroid',
      running: info?.status === 'running',
      paused: info?.status === 'paused',
      endpoint: this.#endpoint,
      since: this.#since,
      containerId: info?.id,
    }
    if (info?.status === 'running') {
      const usage = await this.#sampleUsage()
      if (usage.cpuPct !== undefined) status.cpuPct = usage.cpuPct
      if (usage.memPct !== undefined) status.memPct = usage.memPct
    }
    return status
  }

  /** 尽力而为：docker stats 取不到就省略字段（issue #56）。 */
  async #sampleUsage(): Promise<ProcessUsage> {
    const now = Date.now()
    if (now - this.#usageAt < USAGE_CACHE_MS) return this.#usage
    this.#usage = {}
    try {
      const result = await this.#runner.run(
        'docker',
        ['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemPerc}}', this.#name],
        { timeoutMs: 8_000 },
      )
      if (result.code === 0) {
        const match = /([\d.]+)%\s+([\d.]+)%/.exec(result.stdout)
        if (match) {
          const cpuPct = Number(match[1])
          const memPct = Number(match[2])
          if (Number.isFinite(cpuPct)) this.#usage.cpuPct = Math.round(cpuPct * 10) / 10
          if (Number.isFinite(memPct)) this.#usage.memPct = Math.round(memPct * 10) / 10
        }
      }
    } catch {
      this.#usage = {}
    }
    this.#usageAt = now
    return this.#usage
  }

  async #create(): Promise<void> {
    const args = [
      'run',
      '-d',
      '--name',
      this.#name,
      '--restart=no',
      '--privileged',
      '--memory',
      this.#options.memLimit,
      '--cpus',
      String(this.#options.vcpuLimit),
      '-v',
      '/lib/modules:/lib/modules:ro',
      '-p',
      `127.0.0.1:${this.#endpoint.port}:5555`,
      this.#options.image,
    ]
    await this.#docker(args)
  }

  async #waitReady(
    onProgress?: (message: string, phase?: BootPhase) => void,
  ): Promise<boolean> {
    onProgress?.(`等待 redroid adbd 就绪（${formatEndpoint(this.#endpoint)}）…`, 'waiting-adbd')
    return this.#env.waitForPort(this.#endpoint, {
      timeoutMs: DEFAULT_REDROID_BOOT_TIMEOUT_MS,
      intervalMs: 500,
    })
  }

  async #inspect(): Promise<ContainerInfo | undefined> {
    const result = await this.#runner.run(
      'docker',
      ['inspect', '--format', INSPECT_FORMAT, this.#name],
      { timeoutMs: 20_000 },
    )
    if (result.code !== 0) {
      const output = `${result.stderr}\n${result.stdout}`
      if (/no such object|no such container|not found/i.test(output)) {
        return undefined
      }
      throw this.#failure('检查容器状态失败', result)
    }
    const line = result.stdout.trim()
    if (!line) return undefined
    const [status = 'unknown', id = ''] = line.split('\t')
    return { status, id }
  }

  async #docker(args: readonly string[]): Promise<CommandResult> {
    const result = await this.#runner.run('docker', args, {
      timeoutMs: DOCKER_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      throw this.#failure(`docker ${args[0]} 失败`, result)
    }
    return result
  }

  #failure(prefix: string, result: CommandResult): RuntimeError {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 800)
    const daemonDown = /cannot connect to the docker daemon|error during connect|is the docker daemon running/i.test(
      detail,
    )
    const hint = daemonDown
      ? '（Docker 守护进程不可用：请启动 Docker 服务并确认当前用户有权限访问 docker socket）'
      : ''
    return new RuntimeError(`${prefix}${hint}: ${detail || '无输出'}`, 'start')
  }
}

/** 默认 redroid 配置（宿主层可用作兜底值）。 */
export const DEFAULT_REDROID_OPTIONS: RedroidOptions = DEFAULT_RUNTIME_OPTIONS.redroid
