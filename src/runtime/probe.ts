/**
 * 真实系统环境探测（供 detect.ts 的决策树使用）。
 *
 * 所有实现都走 Node API / SDK 可执行文件，**不调用 adb 二进制**（SPEC §3.2）。
 * 单测注入假的 {@link RuntimeEnvironment}，不依赖本机环境。
 */

import { access } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { waitUntil } from '../adb/timing.ts'
import { createCommandRunner } from './command.ts'
import type {
  CommandRunner,
  Endpoint,
  Platform,
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
  }
}
