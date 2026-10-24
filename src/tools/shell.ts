import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { RESULT_SCHEMA, guarded, renderResult, type ToolDeps } from './common.ts'
import { SHELL_WHITELIST_SUMMARY } from './shell-policy.ts'

/** phone_shell：高危工具；默认走 tools/pre-execute 审批（白名单查询类免确认）。 */
export function createShellTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_shell',
    description:
      '在 Android 设备上执行原始 shell 命令（高风险）。默认走 ask 审批，需要用户在右侧栏确认；仅查询类白名单免确认：' +
      SHELL_WHITELIST_SUMMARY +
      '。能用 phone_tap/screenshot/input_text 等 8 个工具时不要用它。命令在设备端执行，与宿主机是否安装 adb 无关。',
    parameters: {
      cmd: { type: 'string', required: true, description: '要执行的设备端 shell 命令' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
    execute(args) {
      return guarded(deps.service, async () => {
        const output = await deps.service.shell(args.cmd)
        const trimmed = output.trim()
        return {
          message: trimmed.length > 0 ? trimmed : `（命令无输出）${args.cmd}`,
          data: { cmd: args.cmd },
        }
      })
    },
  })
}
