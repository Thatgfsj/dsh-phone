import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { RESULT_SCHEMA, guarded, renderResult, type ToolDeps } from './common.ts'

/** phone_input_text：中文/任意 UTF-8 文本，走 scrcpy 控制通道 INJECT_TEXT。 */
export function createInputTextTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_input_text',
    description:
      '向当前聚焦的输入框注入文本，支持中文与任意 UTF-8（内部走 scrcpy 控制通道 INJECT_TEXT，不是 shell input text 的 ASCII 限制）。调用前先用 phone_screenshot 确认输入框已聚焦；逐字 key 模拟不可用于中文。',
    parameters: {
      text: { type: 'string', required: true, description: '要注入的文本（支持中文）' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
    execute(args) {
      return guarded(deps.service, async () => {
        await deps.service.inputText(args.text)
        return { message: `已注入文本（${args.text.length} 字符）` }
      })
    },
  })
}
