/**
 * 9 个 phone_* 工具注册汇总（名称/参数严格按 SPEC §4）。
 *
 * 注册顺序（docs/architecture.md §1）：config → phone service → tools → http/ws。
 * 每个注册都经 `ctx.effect`，插件卸载时按逆序回收。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { createAppLaunchTool } from './app-launch.ts'
import { createDumpTool } from './uiautomator-dump.ts'
import type { ToolDeps, ToolHostLike } from './common.ts'
import { createInputTextTool } from './input-text.ts'
import { createKeyTool } from './key.ts'
import { createScreenshotTool } from './screenshot.ts'
import { createShellTool } from './shell.ts'
import { createStatusTool } from './status.ts'
import { createSwipeTool } from './swipe.ts'
import { createTapTool } from './tap.ts'

/** 9 个工具工厂（顺序即注册顺序；测试据此断言工具清单）。 */
export const PHONE_TOOL_FACTORIES = [
  createStatusTool,
  createScreenshotTool,
  createTapTool,
  createSwipeTool,
  createKeyTool,
  createInputTextTool,
  createAppLaunchTool,
  createDumpTool,
  createShellTool,
] as const satisfies readonly ((deps: ToolDeps) => ToolDefinition)[]

/** SPEC §4 的 9 个工具名（验收用常量）。 */
export const PHONE_TOOL_NAMES = [
  'phone_status',
  'phone_screenshot',
  'phone_tap',
  'phone_swipe',
  'phone_key',
  'phone_input_text',
  'phone_app_launch',
  'phone_uiautomator_dump',
  'phone_shell',
] as const

export function createPhoneTools(deps: ToolDeps): ToolDefinition[] {
  return PHONE_TOOL_FACTORIES.map((factory) => factory(deps))
}

/** 逐工具注册（ctx.tools.register 本身是 effect；这里再包一层确保顺序回收）。 */
export function registerPhoneTools(host: ToolHostLike, deps: ToolDeps): void {
  for (const factory of PHONE_TOOL_FACTORIES) {
    host.effect(() => host.tools.register(factory(deps)))
  }
}
