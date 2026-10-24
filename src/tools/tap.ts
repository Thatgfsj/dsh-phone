import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { RESULT_SCHEMA, guarded, renderResult, type ToolDeps } from './common.ts'

/** phone_tap：坐标必须来自最近一次截图或 uiautomator_dump。 */
export function createTapTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_tap',
    description:
      '点击 Android 屏幕坐标 (x,y)（像素，来自最近一次 phone_screenshot 的视觉定位或 phone_uiautomator_dump 的 bounds 中心，禁止凭记忆猜坐标）。执行后等待约 300ms 再截图验证；支付/发送/删除等不可逆操作前先向用户说明。',
    parameters: {
      x: { type: 'integer', required: true, description: '像素 x 坐标' },
      y: { type: 'integer', required: true, description: '像素 y 坐标' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
    execute(args) {
      return guarded(deps, async () => {
        await deps.service.tap(args.x, args.y)
        return { message: `已点击 (${args.x}, ${args.y})` }
      })
    },
  })
}