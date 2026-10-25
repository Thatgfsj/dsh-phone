/**
 * Provisioning 白名单命令构建器（issue #65）。
 *
 * 全部参数固定（包名/镜像/AVD 名/设备），不接受用户输入拼接；
 * 安装文案与 AVD/镜像常量复用 `src/runtime/install-guide.ts`（#38 单一数据源）。
 */
import { AVD_NAME, EMULATOR_PACKAGE, SYSTEM_IMAGE } from '../runtime/install-guide.ts'
import type { Platform } from '../runtime/types.ts'
import type { ProvisionImage, SdkTools } from './types.ts'

export type { SdkTools } from './types.ts'
import { PROVISION_LOG_LIMIT, systemImageFor } from './types.ts'

export const AVD_DEVICE = 'pixel_5'

export interface CommandSpec {
  file: string
  args: string[]
  timeoutMs: number
  /** 日志里展示的可读命令（不含环境变量展开）。 */
  display: string
}

function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/** SDK 工具定位：优先 avdmanager 同目录的 sdkmanager；退回 PATH。 */
export async function locateSdkTools(deps: {
  platform(): Promise<Platform>
  pathExists(path: string): Promise<boolean>
  hasCommand(command: string): Promise<boolean>
  findAvdManager(): Promise<string | undefined>
}): Promise<SdkTools | undefined> {
  const platform = await deps.platform()
  const avdmanager = await deps.findAvdManager()
  if (avdmanager) {
    const separator = platform === 'windows' ? '\\' : '/'
    const directory = avdmanager.includes(separator)
      ? avdmanager.slice(0, avdmanager.lastIndexOf(separator))
      : ''
    const name = platform === 'windows' ? 'sdkmanager.bat' : 'sdkmanager'
    const sibling = directory ? directory + separator + name : name
    if (await deps.pathExists(sibling)) return { sdkmanager: sibling, avdmanager }
    if (await deps.hasCommand('sdkmanager')) return { sdkmanager: 'sdkmanager', avdmanager }
  }
  if (await deps.hasCommand('sdkmanager')) {
    const fallback = await deps.findAvdManager()
    if (fallback) return { sdkmanager: 'sdkmanager', avdmanager: fallback }
  }
  return undefined
}

export function sdkmanagerInstallCommand(tools: SdkTools, image: ProvisionImage | undefined): CommandSpec {
  const systemImage = systemImageFor(image)
  return {
    file: tools.sdkmanager,
    args: ['--install', EMULATOR_PACKAGE, systemImage],
    timeoutMs: 10 * 60_000,
    display: tools.sdkmanager + ' --install ' + EMULATOR_PACKAGE + ' ' + systemImage,
  }
}

/** sdkmanager 许可确认：stdin 恒为 yes（固定管道，不接受用户输入）。 */
export function sdkmanagerLicensesCommand(tools: SdkTools, platform: Platform): CommandSpec {
  const command = 'yes | ' + quoteShell(tools.sdkmanager) + ' --licenses'
  if (platform === 'windows') {
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', 'echo y| "' + tools.sdkmanager + '" --licenses'],
      timeoutMs: 120_000,
      display: 'echo y | sdkmanager --licenses',
    }
  }
  return {
    file: 'sh',
    args: ['-c', command],
    timeoutMs: 120_000,
    display: 'yes | sdkmanager --licenses',
  }
}

export function avdListCommand(tools: SdkTools): CommandSpec {
  return {
    file: tools.avdmanager,
    args: ['list', 'avd'],
    timeoutMs: 30_000,
    display: tools.avdmanager + ' list avd',
  }
}

/** 只创建/复用 dsh-phone-avd；调用前已确认它不存在（绝不碰用户其它 AVD）。 */
export function avdCreateCommand(tools: SdkTools, image: ProvisionImage | undefined): CommandSpec {
  const systemImage = image ? systemImageFor(image) : SYSTEM_IMAGE
  return {
    file: tools.avdmanager,
    args: ['create', 'avd', '-n', AVD_NAME, '-k', systemImage, '-d', AVD_DEVICE, '--force'],
    timeoutMs: 120_000,
    display: tools.avdmanager + ' create avd -n ' + AVD_NAME + ' -k ' + systemImage,
  }
}

/** 由命令输出提取进度百分比（sdkmanager 的 "Progress: 42%" / "42%"）。 */
export function parseProgressPercent(text: string): number | undefined {
  const matches = [...text.matchAll(/(\d{1,3})\s*%/g)]
  if (matches.length === 0) return undefined
  const values = matches
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100)
  if (values.length === 0) return undefined
  return Math.max(...values)
}

/** 命令输出 → 日志行（去空行、截断 200 字符、最多 limit 行）。 */
export function outputToLogLines(text: string, limit = 10): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-limit)
    .map((line) => (line.length > 200 ? line.slice(0, 200) + '…' : line))
}

/** 日志环形裁剪（保留最近 PROVISION_LOG_LIMIT 行）。 */
export function trimLog(log: string[]): string[] {
  return log.length <= PROVISION_LOG_LIMIT ? log : log.slice(-PROVISION_LOG_LIMIT)
}