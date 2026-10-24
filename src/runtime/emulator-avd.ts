/**
 * emulator 的 AVD 与端口选择（issue #56）。
 *
 * - AVD 安全化：显式 avdName 优先且必须存在；自动建/选只认 dsh-phone- 前缀，
 *   绝不静默劫持用户自己的 AVD（如 Pixel_7_API_34）。
 * - 端口选择：默认 5554/5555 被占用时，向上找空闲的偶数 console 端口（adb = console + 1）。
 */

import { AVD_NAME, SYSTEM_IMAGE } from './install-guide.ts'
import { DEFAULT_ADB_HOST } from './types.ts'
import { RuntimeError } from './types.ts'
import type { CommandRunner, Endpoint, RuntimeEnvironment } from './types.ts'

/** 自动创建/选择的 AVD 必须带此前缀。 */
export const AVD_PREFIX = 'dsh-phone-'
export const CONSOLE_PORT_BASE = 5554
export const CONSOLE_PORT_MAX = 5584
/** 端口探测单次等待（毫秒）：只判断“是否有人在听”，不做长时间轮询。 */
const PORT_PROBE_TIMEOUT_MS = 300

export interface AvdResolution {
  name: string
  /** 是否为本次自动创建。 */
  created: boolean
}

export interface AvdResolveOptions {
  /** 配置里的 emulator.avdName（空 = 自动）。 */
  avdName: string
  systemImage?: string
  runner: CommandRunner
  env: RuntimeEnvironment
  emulatorPath: string
  onProgress?(message: string, phase?: 'launching'): void
}

/** 列出已有 AVD（emulator -list-avds）。 */
export async function listAvds(
  runner: CommandRunner,
  emulatorPath: string,
): Promise<string[]> {
  const result = await runner.run(emulatorPath, ['-list-avds'], { timeoutMs: 20_000 })
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 自动模式下只挑 dsh-phone- 前缀的 AVD。 */
export function pickAutoAvd(avds: readonly string[]): string | undefined {
  return avds.find((name) => name.startsWith(AVD_PREFIX))
}

/**
 * 解析要使用的 AVD：
 * 1. 配置 avdName 非空 → 必须存在，否则报明确错误（不做“取第一个”兜底）；
 * 2. 否则挑已有 dsh-phone-* AVD；
 * 3. 都没有 → 用 avdmanager 自动创建 dsh-phone-avd。
 */
export async function resolveAvd(options: AvdResolveOptions): Promise<AvdResolution> {
  const explicit = options.avdName.trim()
  if (explicit) {
    const avds = await listAvds(options.runner, options.emulatorPath)
    if (!avds.includes(explicit)) {
      throw new RuntimeError(
        `配置的 emulator.avdName="${explicit}" 不存在。` +
          (avds.length > 0
            ? `已有 AVD：${avds.join(', ')}。`
            : '当前没有任何 AVD。') +
          '请修正 dsh-phone.emulator.avdName，或在 Android Studio 里创建后重试。',
        'start',
      )
    }
    return { name: explicit, created: false }
  }

  const avds = await listAvds(options.runner, options.emulatorPath)
  const existing = pickAutoAvd(avds)
  if (existing) return { name: existing, created: false }

  options.onProgress?.(
    `没有 ${AVD_PREFIX}* AVD（已有：${avds.join(', ') || '无'}），尝试用 avdmanager 创建 ${AVD_NAME} …`,
    'launching',
  )
  await createAvd(options)
  return { name: AVD_NAME, created: true }
}

async function createAvd(options: AvdResolveOptions): Promise<void> {
  const systemImage = options.systemImage?.trim() || SYSTEM_IMAGE
  const avdmanager =
    (await options.env.findAvdManager(options.emulatorPath)) ??
    (await fallbackAvdManager(options))
  if (!avdmanager) {
    throw new RuntimeError(
      `没有可用的 AVD，且找不到 avdmanager（已探测 cmdline-tools/{latest,各版本}/bin、` +
        'SDK 根 tools/bin、ANDROID_HOME/ANDROID_SDK_ROOT 与 PATH）。' +
        '请安装 Android Studio 的 cmdline-tools，或在 dsh-phone.emulator.avdName 填入已有 AVD。',
      'start',
    )
  }

  const result = await options.runner.run(
    avdmanager,
    ['create', 'avd', '-n', AVD_NAME, '-k', systemImage, '--force'],
    { timeoutMs: 60_000 },
  )
  if (result.code !== 0) {
    throw new RuntimeError(
      `没有可用的 AVD，自动创建 ${AVD_NAME} 也失败（需要已安装 system image ${systemImage}）。` +
        '请在 Android Studio 里创建 AVD，或在 dsh-phone.emulator.avdName 填入已有 AVD 名称。' +
        `\n详细输出: ${result.stderr.trim() || result.stdout.trim()}`,
      'start',
    )
  }
}

/** 兜底：PATH / ANDROID_HOME 下的 avdmanager（不依赖 emulator 路径）。 */
async function fallbackAvdManager(
  options: AvdResolveOptions,
): Promise<string | undefined> {
  return options.env.findAvdManager(undefined)
}

/**
 * 选一个空闲的 emulator console 端口（偶数）并返回对应 adb 端点（console + 1）。
 * - 显式配置了 emulator.port：console = port - 1，必须空闲，否则明确报错；
 * - 否则从 5554 起向上找空闲偶数 console（5556/5558…，上限 5584）。
 */
export async function selectEmulatorEndpoint(
  env: RuntimeEnvironment,
  configuredAdbPort?: number,
): Promise<{ endpoint: Endpoint; consolePort: number }> {
  const isFree = async (consolePort: number): Promise<boolean> => {
    if (await env.isPortBusy(consolePort, PORT_PROBE_TIMEOUT_MS)) return false
    if (await env.isPortBusy(consolePort + 1, PORT_PROBE_TIMEOUT_MS)) return false
    return true
  }

  if (configuredAdbPort !== undefined) {
    const consolePort = configuredAdbPort - 1
    if (!(await isFree(consolePort))) {
      throw new RuntimeError(
        `配置的 emulator.port=${configuredAdbPort}（console ${consolePort}）已被占用；` +
          '请修改 dsh-phone.emulator.port 或释放该端口。',
        'start',
      )
    }
    return { endpoint: { host: DEFAULT_ADB_HOST, port: configuredAdbPort }, consolePort }
  }

  for (let consolePort = CONSOLE_PORT_BASE; consolePort <= CONSOLE_PORT_MAX; consolePort += 2) {
    if (await isFree(consolePort)) {
      return {
        endpoint: { host: DEFAULT_ADB_HOST, port: consolePort + 1 },
        consolePort,
      }
    }
  }
  throw new RuntimeError(
    `没有空闲的 emulator console 端口（${CONSOLE_PORT_BASE}–${CONSOLE_PORT_MAX} 都被占用）；` +
      '请先关闭其它 emulator/模拟器进程后重试。',
    'start',
  )
}
