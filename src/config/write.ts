/**
 * 配置写入封装：唯一写路径 = `ctx.settings.mutate`（SPEC §6.2 R1/R4）。
 *
 * - 只允许 SPEC §6.1 的三个 volatile 叶子（attach.endpoint / userHint / resolved）；
 * - 禁止读写 `<profile>/cordis.patch.yml`（由 dsh-settings/configEditor 负责落盘、
 *   注释与顺序保留、原子写与失败回滚，见 docs/calibration.md §2.3）；
 * - 写后必须 describe 回读并逐字段比对（R4 双验证）；
 * - revision 冲突自动重读后重试一次，仍冲突抛 `conflict`（HTTP 409）。
 */
import { CONFIG_NS } from './schema.ts'

export interface SettingsPathOpLike {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

export interface SettingsDescriptorLike {
  ns: string
  revision: number
  value?: unknown
}

/** ctx.settings 的窄接口（单测注入假 settings）。 */
export interface SettingsFacade {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptorLike[]
  mutate(
    ns: string,
    ops: readonly SettingsPathOpLike[],
    expectedRevision?: number,
  ): Promise<void>
}

export type ConfigWriteErrorCode =
  | 'no-settings'
  | 'no-entry'
  | 'bad-path'
  | 'conflict'
  | 'verify'

export class ConfigWriteError extends Error {
  readonly code: ConfigWriteErrorCode

  constructor(code: ConfigWriteErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConfigWriteError'
    this.code = code
  }
}

/** R1 白名单：可实时写入的三个叶子。 */
export const WRITABLE_PATHS: readonly (readonly string[])[] = [
  ['attach', 'userHint'],
  ['attach', 'endpoint'],
  ['attach', 'resolved'],
]

export function pathKey(path: readonly string[]): string {
  return path.join('.')
}

export function isWritablePath(path: readonly string[]): boolean {
  const key = pathKey(path)
  return WRITABLE_PATHS.some((candidate) => pathKey(candidate) === key)
}

export function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left as Record<string, unknown>).sort()
  const rightKeys = Object.keys(right as Record<string, unknown>).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] &&
      deepEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  )
}

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  const name = (error as { name?: unknown }).name
  return code === 'SETTINGS_CONFLICT' || name === 'SettingsConflictError'
}

/** 找到 dsh-phone 的 settings 描述符；缺失时抛结构化错误。 */
export function describeEntry(settings: SettingsFacade | undefined): SettingsDescriptorLike {
  if (!settings) {
    throw new ConfigWriteError(
      'no-settings',
      'ctx.settings 不可用：当前 profile 没有设置服务，无法读写 dsh-phone 配置',
    )
  }
  const descriptor = settings
    .describe({ redactSecrets: true })
    .find((entry) => entry.ns === CONFIG_NS)
  if (!descriptor) {
    throw new ConfigWriteError(
      'no-entry',
      'profile 中找不到 dsh-phone 配置行（插件未安装或行 id 被改名）',
    )
  }
  return descriptor
}

function assertWritablePath(path: readonly string[]): void {
  if (!isWritablePath(path)) {
    throw new ConfigWriteError(
      'bad-path',
      '不允许写入 ' + pathKey(path) + '；只允许 ' +
        WRITABLE_PATHS.map(pathKey).join(' / '),
    )
  }
}

export interface WriteConfigResult {
  /** 写后回读的完整 volatile 子树。 */
  value: unknown
  /** 写后 revision。 */
  revision: number
  /** 实际写入的路径与值。 */
  path: readonly string[]
  written: unknown
}

/**
 * 写一个 volatile 叶子并回读验证（R1 + R4）。
 *
 * @param expectedRevision 来自最近一次 describe 的 revision；缺省用当前 revision。
 */
export async function writeConfigValue(
  settings: SettingsFacade | undefined,
  path: readonly string[],
  value: unknown,
  expectedRevision?: number,
): Promise<WriteConfigResult> {
  assertWritablePath(path)
  let descriptor = describeEntry(settings)
  const facade = settings as SettingsFacade
  const ops: SettingsPathOpLike[] = [{ op: 'set', path, value }]

  let expected = expectedRevision ?? descriptor.revision
  try {
    await facade.mutate(CONFIG_NS, ops, expected)
  } catch (error) {
    if (!isConflict(error)) throw error
    // 冲突重试一次：重新 describe 取最新 revision（architecture §7）
    descriptor = describeEntry(facade)
    expected = descriptor.revision
    try {
      await facade.mutate(CONFIG_NS, ops, expected)
    } catch (retryError) {
      if (isConflict(retryError)) {
        throw new ConfigWriteError(
          'conflict',
          '配置已被其他操作修改（revision 冲突），请刷新设置页后重试',
          { cause: retryError },
        )
      }
      throw retryError
    }
  }

  // R4：回读双验证（第二个验证是路由层重新连通的 phone_status）
  const readBack = describeEntry(facade)
  const actual = readPath(readBack.value, path)
  if (!deepEqual(actual, value)) {
    throw new ConfigWriteError(
      'verify',
      '配置写入回读校验失败：' + pathKey(path) + ' 期望 ' +
        JSON.stringify(value) + ' 实际 ' + JSON.stringify(actual),
    )
  }
  return { value: readBack.value, revision: readBack.revision, path, written: value }
}
