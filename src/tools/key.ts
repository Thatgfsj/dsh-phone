import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { RESULT_SCHEMA, guarded, renderResult, type ToolDeps } from './common.ts'

/** phone_key：标准 keyevent。 */
export function createKeyTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_key',
    description:
      '发送标准 Android 按键：HOME / BACK / RECENTS / ENTER / DEL / MENU / ESCAPE / TAB / SPACE / POWER / WAKEUP / SLEEP / VOLUME_UP / VOLUME_DOWN / SEARCH 等（也接受数字 keycode 或 KEYCODE_* 全名）。用于返回、回桌面、确认等；文字输入请用 phone_input_text 而非逐键模拟。',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: '按键名，如 HOME、BACK、RECENTS、ENTER、DEL',
      },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
    execute(args) {
      return guarded(deps, async () => {
        await deps.service.key(args.name)
        return { message: `已发送按键 ${args.name}` }
      })
    },
  })
}