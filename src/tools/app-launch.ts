import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { RESULT_SCHEMA, guarded, renderResult, type ToolDeps } from './common.ts'

/** phone_app_launch：按包名启动（monkey，无需 Activity 名）。 */
export function createAppLaunchTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_app_launch',
    description:
      '按包名启动应用（如 com.android.settings）。不确定 Activity 时内部用 monkey 的 LAUNCHER intent 启动，不需要 Activity 名。启动后等待 1–2 秒再截图；包名不确定时可先用 phone_shell 白名单命令查询已安装包。',
    parameters: {
      pkg: {
        type: 'string',
        required: true,
        description: '应用包名，如 com.android.settings',
      },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
    execute(args) {
      return guarded(deps, async () => {
        await deps.service.appLaunch(args.pkg)
        return { message: `已启动应用 ${args.pkg}` }
      })
    },
  })
}