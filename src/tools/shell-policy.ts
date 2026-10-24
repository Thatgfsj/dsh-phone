/**
 * phone_shell 审批策略（SPEC §6.3 / architecture §2.2）。
 *
 * - 白名单命令（查询类）免确认：`getprop`、`wm size`、`dumpsys` 的只读子集；
 * - 其余一律由 `tools/pre-execute` waterfall 返回 `{kind:'ask',...}`，交用户审批；
 * - 纯函数、无 I/O，单测覆盖（tests/host/shell-policy.test.ts）。
 */

/** dumpsys 只读子集：仅这些 service 的只读查询免确认。 */
export const DUMPSYS_READONLY_SERVICES = [
  'activity',
  'window',
  'display',
  'battery',
  'cpuinfo',
  'meminfo',
  'gfxinfo',
  'input',
  'power',
  'wifi',
] as const

/** shell 元字符（分号、管道、重定向、替换、换行等）：出现即视为非白名单。 */
const SHELL_METACHARACTERS = /[;&|<>$`(){}[\]\n\r]/
/** getprop 允许的单个属性名（含 ro.xxx）。 */
const GETPROP = /^getprop(?:\s+[A-Za-z0-9_.:-]+)?$/
/** wm size：只允许查询，不允许 wm size <WxH> 改分辨率。 */
const WM_SIZE = /^wm\s+size$/
/** dumpsys <service> [只读参数...]。 */
const DUMPSYS = /^dumpsys\s+([a-z][a-z0-9_-]*)(?:\s+[A-Za-z0-9_.:/-]+)*$/

/** 判定结果：allow 直接放行，ask 需要用户审批。 */
export type ShellCommandDecision =
  | { kind: 'allow' }
  | {
      kind: 'ask'
      reason: string
      displayReason: { en: string; zh: string }
    }

export function isWhitelistedShellCommand(raw: string): boolean {
  const command = raw.trim()
  if (command.length === 0 || command.length > 500) return false
  if (SHELL_METACHARACTERS.test(command)) return false
  if (GETPROP.test(command)) return true
  if (WM_SIZE.test(command)) return true
  const match = DUMPSYS.exec(command)
  if (!match) return false
  const service = match[1] as string
  return (DUMPSYS_READONLY_SERVICES as readonly string[]).includes(service)
}

/**
 * 生成 `tools/pre-execute` 的决策：白名单 → 放行，其余 → ask。
 * `phone_shell` 只做原始设备 shell，调用前必须让用户知情（SPEC §6.3）。
 */
export function evaluateShellCommand(raw: string): ShellCommandDecision {
  const command = raw.trim()
  if (isWhitelistedShellCommand(command)) return { kind: 'allow' }
  return {
    kind: 'ask',
    reason:
      'phone_shell 将在 Android 设备上执行非白名单命令：' + command +
      '（白名单仅 getprop / wm size / dumpsys 只读子集）',
    displayReason: {
      en: 'Run a non-whitelisted command on the Android device: ' + command,
      zh: '将在 Android 设备上执行非白名单命令：' + command,
    },
  }
}

/** 白名单摘要（工具描述与文档共用，避免多处手写漂移）。 */
export const SHELL_WHITELIST_SUMMARY =
  'getprop、wm size、dumpsys 只读 service（' + DUMPSYS_READONLY_SERVICES.join('/') + '）'
/* ------------------------------ pre-execute 接线 ------------------------------ */

export interface ShellApprovalExec {
  name: string
  arguments?: unknown
}

export type ShellApprovalNext = () => Promise<unknown>

/** tools/pre-execute 的最小宿主结构（单测注入假 ctx；index 传真 ctx）。 */
export interface ShellApprovalHost {
  on(
    event: 'tools/pre-execute',
    listener: (exec: ShellApprovalExec, next: ShellApprovalNext) => Promise<unknown>,
  ): unknown
}

/**
 * 注册 phone_shell 审批 waterfall（SPEC §6.3，architecture §2.2）：
 * 白名单命令 `next()` 放行；其余返回 `{kind:'ask', reason, displayReason:{en,zh}}`。
 */
export function registerShellApproval(host: ShellApprovalHost): void {
  host.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'phone_shell') return next()
    const args = exec.arguments as { cmd?: unknown } | undefined
    const command = typeof args?.cmd === 'string' ? args.cmd : ''
    const decision = evaluateShellCommand(command)
    if (decision.kind === 'allow') return next()
    return {
      kind: 'ask',
      reason: decision.reason,
      displayReason: decision.displayReason,
    }
  })
}
