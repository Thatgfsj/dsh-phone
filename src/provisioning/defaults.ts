/** Provisioner 的默认真实依赖（测试通过构造函数注入假实现）。 */
import { access, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { connect, disconnect } from '../adb/transport.ts'
import type { CommandRunner, RuntimeEnvironment } from '../runtime/types.ts'
import { Provisioner } from './service.ts'
import type { ProvisionDeps } from './types.ts'

export interface DefaultProvisionerOptions {
  env: RuntimeEnvironment
  runner: CommandRunner
  verifyEndpoint(endpoint: string): Promise<{
    ok: boolean
    latencyMs: number
    banner?: string
    error?: string
  }>
  getAttachEndpoint(): string
}

/** 默认磁盘余量探测：SDK 根/家目录 statfs；取不到视为“未知/充足”。 */
async function freeDiskBytes(): Promise<number> {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Android', 'Sdk'),
    homedir(),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    try {
      const stats = await statfs(candidate)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      // 该路径不存在/不可读，试下一个
    }
  }
  return Number.MAX_SAFE_INTEGER
}

/** 包内脚本存在性（issue #88；固定路径只在 service 里拼接）。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 定制脚本 reboot 后等待 sys.boot_completed（issue #88）。
 *
 * 用 Tango ADB 直连默认 emulator adb 端口 127.0.0.1:5555（不依赖宿主机 adb 二进制）。
 * 端口非默认时无法等待：返回 false，provision log 会给出警告（不失败）。
 */
async function waitForBootCompleted(): Promise<boolean> {
  const endpoint = { host: '127.0.0.1', port: 5555 }
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    let connection: Awaited<ReturnType<typeof connect>> | undefined
    try {
      connection = await connect(endpoint, { timeoutMs: 2_000 })
      const value = await connection.shell('getprop sys.boot_completed', { timeoutMs: 3_000 })
      if (value.trim().startsWith('1')) return true
    } catch {
      // 重启过程中连接会失败，继续轮询
    } finally {
      if (connection) await disconnect(connection).catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  return false
}

/** 组装真实 Provisioner（index 调用；不依赖 web 服务）。 */
export function createProvisioner(options: DefaultProvisionerOptions): Provisioner {
  const { env, runner } = options
  const deps: ProvisionDeps = {
    runner,
    platform: () => env.platform(),
    pathExists: (path) => env.pathExists(path),
    hasCommand: (command) => env.hasCommand(command),
    findEmulator: () => env.findEmulator(),
    findAvdManager: () => env.findAvdManager(),
    freeDiskBytes,
    verifyEndpoint: options.verifyEndpoint,
    getAttachEndpoint: options.getAttachEndpoint,
    fileExists,
    waitForBootCompleted,
  }
  return new Provisioner(deps)
}