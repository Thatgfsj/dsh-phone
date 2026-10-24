import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { RESULT_SCHEMA, guarded, renderResult, type ToolDeps } from './common.ts'

/** phone_uiautomator_dump：控件树（与截图构成视觉+控件树双通道校验）。 */
export function createDumpTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_uiautomator_dump',
    description:
      '导出当前界面的 uiautomator 控件树 XML（含 text、content-desc、bounds、clickable）。文本框、列表项、按钮等场景优先用它拿精确坐标（bounds 中心即 tap 坐标），与 phone_screenshot 构成“视觉+控件树”双通道校验。返回内容较长时注意只读需要的节点。',
    parameters: {},
    output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
    execute() {
      return guarded(deps, async () => {
        const xml = await deps.service.dumpUi()
        return { message: xml }
      })
    },
  })
}