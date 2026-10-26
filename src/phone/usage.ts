/**
 * attach 实例的 CPU/内存占用采样（issue #56，尽力而为）。
 *
 * 通过设备 shell 读取（不依赖宿主机 adb）：
 * - CPU：`dumpsys cpuinfo` 的 TOTAL 行（user + kernel）；
 * - 内存：`/proc/meminfo` 的 MemTotal / MemAvailable（无 MemAvailable 时用 Free+Buffers+Cached 估算）。
 *
 * 解析失败返回空对象（省略字段），调用方不得因此报错。
 */

import type { ProcessUsage, RuntimeKind } from '../runtime/types.ts'

export const ATTACH_CPU_COMMAND = 'dumpsys cpuinfo'
export const ATTACH_MEM_COMMAND = 'cat /proc/meminfo'

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 解析 `dumpsys cpuinfo` 的 TOTAL 行，如 "TOTAL: 5.2% user + 3.1% kernel + 0.4% iowait"。 */
export function parseDumpsysCpuinfoPct(text: string): number | undefined {
  const total = /TOTAL:\s*([\d.]+)%\s*user\s*\+\s*([\d.]+)%\s*kernel/i.exec(text)
  if (total) {
    const value = Number(total[1]) + Number(total[2])
    return Number.isFinite(value) ? round1(value) : undefined
  }
  return undefined
}

/** 解析 `/proc/meminfo` → 已用内存百分比（0–100）。 */
export function parseMeminfoPct(text: string): number | undefined {
  const totalKb = /MemTotal:\s*(\d+)\s*kB/i.exec(text)
  if (!totalKb) return undefined
  const total = Number(totalKb[1])
  if (!(total > 0)) return undefined

  let availableKb: number | undefined
  const memAvailable = /MemAvailable:\s*(\d+)\s*kB/i.exec(text)
  if (memAvailable) {
    availableKb = Number(memAvailable[1])
  } else {
    const free = /MemFree:\s*(\d+)\s*kB/i.exec(text)
    if (!free) return undefined
    const buffers = /Buffers:\s*(\d+)\s*kB/i.exec(text)
    const cached = /^Cached:\s*(\d+)\s*kB/im.exec(text)
    availableKb = Number(free[1]) + Number(buffers?.[1] ?? 0) + Number(cached?.[1] ?? 0)
  }
  if (!Number.isFinite(availableKb)) return undefined
  return round1(((total - availableKb) / total) * 100)
}

/** 汇总 attach 采样结果；任一取不到就省略对应字段。 */
export function usageFromAttachOutputs(cpuText: string, memText: string): ProcessUsage {
  const usage: ProcessUsage = {}
  const cpuPct = parseDumpsysCpuinfoPct(cpuText)
  const memPct = parseMeminfoPct(memText)
  if (cpuPct !== undefined) usage.cpuPct = cpuPct
  if (memPct !== undefined) usage.memPct = memPct
  return usage
}


/** attach 资源占用采样缓存（issue #56/#83，避免 /status 轮询频繁 shell）。 */
const USAGE_CACHE_MS = 5_000

export interface UsageSampleInput {
  kind: RuntimeKind
  runtimeStatus: { cpuPct?: number; memPct?: number } | undefined
  device: { shell(command: string): Promise<string> } | undefined
  state: string
  busy: boolean
  now: number
}

/** 资源占用采样器：runtime 已给就直接用；attach 走设备 shell，5s 缓存，失败静默省略。 */
export class UsageSampler {
  #usage: ProcessUsage | undefined
  #usageAt = 0

  reset(): void {
    this.#usage = undefined
    this.#usageAt = 0
  }

  async sample(input: UsageSampleInput): Promise<ProcessUsage> {
    const fromRuntime: ProcessUsage = {}
    if (input.runtimeStatus?.cpuPct !== undefined) fromRuntime.cpuPct = input.runtimeStatus.cpuPct
    if (input.runtimeStatus?.memPct !== undefined) fromRuntime.memPct = input.runtimeStatus.memPct
    if (fromRuntime.cpuPct !== undefined || fromRuntime.memPct !== undefined) return fromRuntime
    if (input.state !== 'running') return {}
    if (input.kind !== 'attach' || !input.device || input.busy) return {}
    if (this.#usageAt !== 0 && input.now - this.#usageAt < USAGE_CACHE_MS) {
      return this.#usage ?? {}
    }
    const usage = await this.#sampleAttach(input.device)
    this.#usage = usage
    this.#usageAt = input.now
    return usage
  }

  async #sampleAttach(device: { shell(command: string): Promise<string> }): Promise<ProcessUsage> {
    try {
      const [cpuText, memText] = await Promise.all([
        device.shell(ATTACH_CPU_COMMAND),
        device.shell(ATTACH_MEM_COMMAND),
      ])
      return usageFromAttachOutputs(cpuText, memText)
    } catch {
      return {}
    }
  }
}
