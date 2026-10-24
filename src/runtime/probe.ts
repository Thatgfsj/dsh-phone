/**
 * 真实系统环境探测（供 detect.ts 的决策树使用）。
 *
 * 所有实现都走 Node API / SDK 可执行文件，**不调用 adb 二进制**（SPEC §3.2）。
 * 单测注入假的 {@link RuntimeEnvironment}，不依赖本机环境。
 */

import { access, readFile, readdir } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { waitUntil } from '../adb/timing.ts'
import { createCommandRunner } from './command.ts'
import type {
  CommandRunner,
  Endpoint,
  Platform,
  ProcessUsage,
  RuntimeEnvironment,
  RuntimeProbe,
  WaitForPortOptions,
} from './types.ts'

export function detectPlatform(): Platform {
  switch (process.platform) {
    case 'linux':
      return 'linux'
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    default:
      return 'other'
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Android SDK emulator 可执行文件的候选路径（按平台，逐个验证，不递归扫盘）。 */
export function emulatorCandidates(
  platform: Platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = []
  const homes = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (value): value is string => Boolean(value && value.trim()),
  )
  if (platform === 'windows') {
    for (const home of homes) {
      candidates.push(join(home, 'emulator', 'emulator.exe'))
    }
    if (env.LOCALAPPDATA) {
      candidates.push(
        join(env.LOCALAPPDATA, 'Android', 'Sdk', 'emulator', 'emulator.exe'),
      )
    }
    return candidates
  }
  const suffix = 'emulator'
  for (const home of homes) {
    candidates.push(join(home, 'emulator', suffix))
  }
  if (platform === 'macos') {
    candidates.push(
      join(homedir(), 'Library', 'Android', 'sdk', 'emulator', suffix),
    )
  } else {
    candidates.push(join(homedir(), 'Android', 'Sdk', 'emulator', suffix))
    candidates.push(join(homedir(), 'android-sdk', 'emulator', suffix))
  }
  return candidates
}

/** 单次 TCP 连接探测（端口是否接受连接）。 */
export function isPortOpen(
  endpoint: Endpoint,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let settled = false
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(open)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function findEmulatorOnPath(runner: CommandRunner): Promise<string | undefined> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = await runner.run(finder, ['emulator'], { timeoutMs: 5_000 })
  if (result.code !== 0) return undefined
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return first
}

/**
 * avdmanager 候选路径（issue #56）：Android Studio 自带 SDK 常没有 cmdline-tools/latest，
 * 需要按版本目录、SDK 根、PATH、ANDROID_HOME/ANDROID_SDK_ROOT 依次探测。
 */
export function avdmanagerCandidates(
  platform: Platform,
  emulatorPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const exe = platform === 'windows' ? 'avdmanager.bat' : 'avdmanager'
  const sdkRoots: string[] = []
  if (emulatorPath) sdkRoots.push(dirname(dirname(emulatorPath)))
  for (const home of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (home && home.trim()) sdkRoots.push(home.trim())
  }
  const candidates: string[] = []
  for (const root of sdkRoots) {
    candidates.push(join(root, 'cmdline-tools', 'latest', 'bin', exe))
    // 各版本目录：cmdline-tools/16.0/bin/avdmanager 等（无法预知版本，交给 findAvdManager 展开）
    candidates.push(join(root, 'cmdline-tools', '*', 'bin', exe))
    candidates.push(join(root, 'tools', 'bin', exe))
  }
  return candidates
}

async function expandVersionedCandidates(candidates: string[]): Promise<string[]> {
  const expanded: string[] = []
  for (const candidate of candidates) {
    const star = candidate.indexOf('*')
    if (star === -1) {
      expanded.push(candidate)
      continue
    }
    const parent = candidate.slice(0, candidate.lastIndexOf('/', star))
    const suffix = candidate.slice(candidate.lastIndexOf('/', star)).replace(/^\//, '')
    let entries: string[] = []
    try {
      entries = await readdir(parent)
    } catch {
      continue
    }
    entries.sort().reverse() // 优先新版本
    for (const entry of entries) {
      expanded.push(join(parent, entry, suffix.replace(/\*/g, entry)))
    }
  }
  return expanded
}

/** SRC 根下的 avdmanager：多候选 + PATH 回退。 */
export async function findAvdManagerPath(
  runner: CommandRunner,
  emulatorPath?: string,
): Promise<string | undefined> {
  const platform = detectPlatform()
  const candidates = await expandVersionedCandidates(
    avdmanagerCandidates(platform, emulatorPath),
  )
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  const finder = platform === 'windows' ? 'where' : 'which'
  const result = await runner.run(finder, ['avdmanager'], { timeoutMs: 5_000 })
  if (result.code !== 0) return undefined
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return first
}

/** /proc/<pid>/stat 的 utime+stime（jiffies）；解析失败返回 undefined。 */
export function parseProcStatJiffies(text: string): number | undefined {
  const close = text.lastIndexOf(')')
  if (close === -1) return undefined
  const fields = text.slice(close + 1).trim().split(/\s+/)
  // fields[0] 对应 stat 的第 3 个字段 state；utime=第 14、stime=第 15
  const utime = Number(fields[11])
  const stime = Number(fields[12])
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined
  return utime + stime
}

/** /proc/<pid>/status 的 VmRSS（kB）；解析失败返回 undefined。 */
export function parseProcStatusRssKb(text: string): number | undefined {
  const match = /VmRSS:\s*(\d+)\s*kB/.exec(text)
  return match ? Number(match[1]) : undefined
}

/** /proc/meminfo 的 MemTotal（kB）；解析失败返回 undefined。 */
export function parseProcMeminfoTotalKb(text: string): number | undefined {
  const match = /MemTotal:\s*(\d+)\s*kB/.exec(text)
  return match ? Number(match[1]) : undefined
}

const CLOCK_TICKS_PER_SECOND = 100
const lastProcSample = new Map<number, { jiffies: number; at: number }>()

/** 采样宿主进程占用（Linux /proc；其它平台或失败返回 {}）。 */
export async function sampleProcessUsage(pid: number): Promise<ProcessUsage> {
  if (detectPlatform() !== 'linux') return {}
  const base = '/proc/' + pid
  try {
    const [stat, status] = await Promise.all([
      readFile(base + '/stat', 'utf8'),
      readFile(base + '/status', 'utf8'),
    ])
    const usage: ProcessUsage = {}
    const rssKb = parseProcStatusRssKb(status)
    const totalKb = parseProcMeminfoTotalKb(await readFile('/proc/meminfo', 'utf8'))
    if (rssKb !== undefined && totalKb !== undefined && totalKb > 0) {
      usage.memPct = Math.round((rssKb / totalKb) * 1000) / 10
    }
    const jiffies = parseProcStatJiffies(stat)
    const now = Date.now()
    const previous = lastProcSample.get(pid)
    if (jiffies !== undefined && previous !== undefined) {
      const deltaJiffies = jiffies - previous.jiffies
      const deltaSeconds = (now - previous.at) / 1000
      if (deltaJiffies >= 0 && deltaSeconds > 0) {
        usage.cpuPct =
          Math.round((deltaJiffies / CLOCK_TICKS_PER_SECOND / deltaSeconds) * 1000) / 10
      }
    }
    if (jiffies !== undefined) lastProcSample.set(pid, { jiffies, at: now })
    return usage
  } catch {
    return {}
  }
}

export function createSystemEnvironment(
  runner: CommandRunner = createCommandRunner(),
): RuntimeEnvironment {
  return {
    async platform() {
      return detectPlatform()
    },

    pathExists,

    async hasCommand(command: string) {
      // Windows 用 where，POSIX 用 which（两者都不依赖 shell 内建）
      const finder = process.platform === 'win32' ? 'where' : 'which'
      const result = await runner.run(finder, [command], { timeoutMs: 5_000 })
      return result.code === 0
    },

    async findEmulator() {
      for (const candidate of emulatorCandidates(detectPlatform())) {
        if (await pathExists(candidate)) return candidate
      }
      return findEmulatorOnPath(runner)
    },

    async acceleration(platform: Platform, emulatorPath?: string) {
      if (platform === 'linux') {
        const kvm = await pathExists('/dev/kvm')
        return kvm
          ? { ok: true, detail: '/dev/kvm 可用' }
          : { ok: false, reason: '缺少 /dev/kvm（需在 BIOS 开启 CPU 虚拟化并加载 kvm 模块）' }
      }
      if (platform === 'macos') {
        return {
          ok: true,
          detail: 'Hypervisor.framework（macOS 默认可用，未逐机验证）',
        }
      }
      if (platform === 'windows') {
        if (!emulatorPath) {
          return { ok: false, reason: '未找到 emulator，无法检查 WHPX' }
        }
        const result = await runner.run(emulatorPath, ['-accel-check'], {
          timeoutMs: 20_000,
        })
        const output = `${result.stdout}\n${result.stderr}`
        const usable = /is installed and usable|WHPX.*usable/i.test(output)
        return usable
          ? { ok: true, detail: 'WHPX 可用' }
          : {
              ok: false,
              reason: 'WHPX 不可用（需开启 Windows 虚拟机平台/Hyper-V 与 BIOS 虚拟化）',
              detail: output.trim().slice(0, 500),
            }
      }
      return { ok: false, reason: `平台 ${platform} 不支持硬件虚拟化检测` }
    },

    async waitForPort(endpoint: Endpoint, options: WaitForPortOptions) {
      return waitUntil(
        () => isPortOpen(endpoint, Math.min(1_000, options.timeoutMs)),
        options.timeoutMs,
        options.intervalMs ?? 250,
      )
    },

    async isPortBusy(port: number, timeoutMs = 300) {
      return isPortOpen({ host: '127.0.0.1', port }, timeoutMs)
    },

    async findAvdManager(emulatorPath?: string) {
      return findAvdManagerPath(runner, emulatorPath)
    },

    async sampleProcessUsage(pid: number) {
      return sampleProcessUsage(pid)
    },
  }
}
