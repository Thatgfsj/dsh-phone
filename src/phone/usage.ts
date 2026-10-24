/**
 * attach 实例的 CPU/内存占用采样（issue #56，尽力而为）。
 *
 * 通过设备 shell 读取（不依赖宿主机 adb）：
 * - CPU：`dumpsys cpuinfo` 的 TOTAL 行（user + kernel）；
 * - 内存：`/proc/meminfo` 的 MemTotal / MemAvailable（无 MemAvailable 时用 Free+Buffers+Cached 估算）。
 *
 * 解析失败返回空对象（省略字段），调用方不得因此报错。
 */

import type { ProcessUsage } from '../runtime/types.ts'

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
