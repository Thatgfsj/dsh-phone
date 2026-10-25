/** Provisioner 的默认真实依赖（测试通过构造函数注入假实现）。 */
import { statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  }
  return new Provisioner(deps)
}