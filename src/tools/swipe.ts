import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { RESULT_SCHEMA, guarded, renderResult, type ToolDeps } from './common.ts'

/** phone_swipe：滚动列表、解锁等；起点/终点同样来自截图或控件树。 */
export function createSwipeTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_swipe',
    description:
      '从 (x1,y1) 滑动到 (x2,y2)，时长 durationMs 毫秒（常用 200–800ms；越短越快）。坐标必须来自最近一次 phone_screenshot 或 phone_uiautomator_dump。用于滚动列表、解锁、切换页面；操作后截图验证。',
    parameters: {
      x1: { type: 'integer', required: true, description: '起点像素 x' },
      y1: { type: 'integer', required: true, description: '起点像素 y' },
      x2: { type: 'integer', required: true, description: '终点像素 x' },
      y2: { type: 'integer', required: true, description: '终点像素 y' },
      durationMs: { type: 'integer', required: true, description: '滑动时长（毫秒）' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
    execute(args) {
      return guarded(deps, async () => {
        await deps.service.swipe(args.x1, args.y1, args.x2, args.y2, args.durationMs)
        return {
          message: `已滑动 (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2})，${args.durationMs}ms`,
        }
      })
    },
  })
}