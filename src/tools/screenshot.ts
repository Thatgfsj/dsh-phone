import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { AttachmentRef } from '../phone/contracts.ts'
import { bootingFailure, failureFrom, type ToolDeps } from './common.ts'

interface ScreenshotValue {
  ok: boolean
  message: string
  image?: AttachmentRef
  fallback?: { bytes: number; note: string }
  code?: string
  retryable?: boolean
  bootMs?: number
}

const SCREENSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string' },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        name: { type: 'string' },
      },
    },
    fallback: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bytes: { type: 'integer', required: true },
        note: { type: 'string', required: true },
      },
    },
    code: { type: 'string' },
    retryable: { type: 'boolean' },
    bootMs: { type: 'integer' },
  },
} as const

/** phone_screenshot：Agent 的“眼睛”，按需单帧（零持续开销）。 */
export function createScreenshotTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'phone_screenshot',
    description:
      '截取 Android 屏幕单帧并作为图片返回。这是 Agent 的“眼睛”：每次 tap/swipe/input_text 前用它定位、后用它验证，禁止盲操作。坐标为截图原始像素坐标。当前会话/模型不支持图片附件时本工具降级为文本（含字节数与提示），不会整体失败。',
    parameters: {},
    output: {
      schema: SCREENSHOT_SCHEMA,
      render: (_args, value) => {
        const message = value.message ?? 'screenshot'
        if (value.image) {
          return [
            { type: 'text', text: message },
            {
              type: 'image',
              attachment: { ...value.image, mediaType: value.image.mediaType as 'image/png' },
            },
          ]
        }
        return [{ type: 'text', text: message }]
      },
    },
    async execute(): Promise<ScreenshotValue> {
      let readiness
      try {
        readiness = await deps.service.ensureInteractive()
      } catch (error) {
        const failure = failureFrom(error)
        return { ...failure, message: failure.message }
      }
      if (readiness.state === 'booting') {
        const failure = bootingFailure(readiness.bootMs)
        return { ...failure, message: failure.message }
      }

      let bytes: Uint8Array
      try {
        bytes = await deps.service.screenshot()
      } catch (error) {
        const failure = failureFrom(error)
        return { ...failure, message: failure.message }
      }

      const attachments = deps.attachments?.()
      if (attachments) {
        try {
          const ref = await attachments.saveImage({
            data: bytes,
            mediaType: 'image/png',
            name: `phone-screenshot-${Date.now()}.png`,
          })
          return {
            ok: true,
            message: `截图 ${ref.width}x${ref.height}（${ref.bytes} 字节）`,
            image: ref,
          }
        } catch {
          // 附件/模型不支持图片：降级文本，不整体失败（architecture §2.1）
        }
      }
      const note =
        '截图已生成但无法作为图片内容块返回（attachments 服务缺失、模型不支持图片输入或超出附件限制）。可改用 phone_uiautomator_dump 获取控件树坐标。'
      return {
        ok: true,
        message: note + ` PNG ${bytes.length} 字节。`,
        fallback: { bytes: bytes.length, note },
      }
    },
  })
}