/**
 * 面板动作 API 的固定动作（issue #100）。
 *
 * 只允许预定义动作 + 固定命令（禁止任意命令拼接）；app-drawer 打开肥鱼定制 app 的
 * DrawerActivity。命令失败/超时/Activity 不存在统一映射为 `E_APP_DRAWER_UNAVAILABLE`，
 * 提示用户运行 `system/provision-device.sh` 或更新定制。
 */
import type { PhoneOperations } from './contracts.ts'

export const PHONE_ACTIONS = ['app-drawer'] as const
export type PhoneAction = (typeof PHONE_ACTIONS)[number]

/** 固定命令（issue #100 冻结；不得拼接任何用户输入）。 */
export const APP_DRAWER_COMMAND =
  'am start -n com.dafeiyu.shell/.DrawerActivity --activity-single-top'
/** 动作超时（issue #100：5s）。 */
export const APP_DRAWER_TIMEOUT_MS = 5_000

export function isPhoneAction(value: unknown): value is PhoneAction {
  return typeof value === 'string' && (PHONE_ACTIONS as readonly string[]).includes(value)
}

/** app-drawer 不可用（未安装/启动失败/超时）→ HTTP 409 E_APP_DRAWER_UNAVAILABLE。 */
export class AppDrawerUnavailableError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AppDrawerUnavailableError'
    this.retryable = retryable
  }
}

const MISSING_ACTIVITY = /Activity class .* does not exist|Error type 3|Unable to find explicit activity|does not exist/i
const TIMEOUT = /timeout|timed out|超时/i

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** `am start` 的输出是否表明 Activity 不存在（缺定制/旧版 app）。 */
export function looksLikeMissingActivity(output: string): boolean {
  return MISSING_ACTIVITY.test(output)
}

/** 把 shell 异常归一化为 E_APP_DRAWER_UNAVAILABLE（超时可重试、未安装不可重试）。 */
export function classifyDrawerFailure(error: unknown): AppDrawerUnavailableError {
  const message = messageOf(error)
  const code = codeOf(error)
  if (code === 'timeout' || code === 'E_TIMEOUT' || TIMEOUT.test(message)) {
    return new AppDrawerUnavailableError(
      '打开应用抽屉超时（am start 超过 5s）：请确认实例运行正常后重试',
      true,
      { cause: error },
    )
  }
  if (looksLikeMissingActivity(message)) {
    return new AppDrawerUnavailableError(
      '应用抽屉不可用：com.dafeiyu.shell/.DrawerActivity 不存在。请运行 system/provision-device.sh 或更新肥鱼手机定制后重试',
      false,
      { cause: error },
    )
  }
  return new AppDrawerUnavailableError(
    '打开应用抽屉失败：' + message + '（可运行 system/provision-device.sh 或更新定制后重试）',
    true,
    { cause: error },
  )
}

/** 执行固定动作（前置 ensureRunning；5s 超时；不接受外部命令）。 */
export async function runPhoneAction(
  action: PhoneAction,
  service: Pick<PhoneOperations, 'ensureRunning' | 'shell'>,
): Promise<void> {
  if (action !== 'app-drawer') {
    throw new AppDrawerUnavailableError('未知动作: ' + String(action), false)
  }
  await service.ensureRunning()
  let output: string
  try {
    output = await service.shell(APP_DRAWER_COMMAND, APP_DRAWER_TIMEOUT_MS)
  } catch (error) {
    throw classifyDrawerFailure(error)
  }
  if (looksLikeMissingActivity(output)) {
    throw new AppDrawerUnavailableError(
      '应用抽屉不可用：com.dafeiyu.shell/.DrawerActivity 不存在。请运行 system/provision-device.sh 或更新肥鱼手机定制后重试',
      false,
    )
  }
}
