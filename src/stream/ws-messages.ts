/**
 * /dsh-phone/stream 文本消息解析与校验（docs/protocol.md §2.3，冻结）。
 *
 * 只做形状校验，不碰业务；非法消息返回 `ok:false`，由 ws 层回 E_BAD_REQUEST。
 */

import type { TouchAction } from './types.ts'

export const STREAM_PROTOCOL_VERSION = 1

export interface HelloMessage {
  kind: 'hello'
  protocol: number
  viewport: { w: number; h: number }
  visible: boolean
}

export type ClientMessage =
  | HelloMessage
  | { kind: 'touch'; action: TouchAction; x: number; y: number }
  | { kind: 'key'; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'visibility'; visible: boolean }
  | { kind: 'ping'; t: number }

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAction(value: unknown): value is TouchAction {
  return value === 'down' || value === 'move' || value === 'up'
}

/** 解析客户端 JSON 文本；未知 type/字段类型错误一律拒绝。 */
export function parseClientMessage(text: string): ParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'JSON 解析失败' }
  }
  if (!isRecord(value)) return { ok: false, reason: '消息必须是 JSON 对象' }
  switch (value.type) {
    case 'hello': {
      if (value.protocol !== STREAM_PROTOCOL_VERSION) {
        return { ok: false, reason: 'protocol 必须为 ' + STREAM_PROTOCOL_VERSION }
      }
      const viewport = value.viewport
      if (!isRecord(viewport) || !isPositiveNumber(viewport.w) || !isPositiveNumber(viewport.h)) {
        return { ok: false, reason: 'viewport 必须包含正数 w/h' }
      }
      if (value.visible !== undefined && typeof value.visible !== 'boolean') {
        return { ok: false, reason: 'visible 必须是 boolean' }
      }
      return {
        ok: true,
        message: {
          kind: 'hello',
          protocol: STREAM_PROTOCOL_VERSION,
          viewport: { w: viewport.w, h: viewport.h },
          visible: value.visible !== false,
        },
      }
    }
    case 'touch': {
      if (!isAction(value.action)) return { ok: false, reason: 'action 必须是 down/move/up' }
      if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
        return { ok: false, reason: 'x/y 必须是数字' }
      }
      return { ok: true, message: { kind: 'touch', action: value.action, x: value.x, y: value.y } }
    }
    case 'key': {
      if (typeof value.name !== 'string' || value.name.length === 0) {
        return { ok: false, reason: 'name 必须是非空字符串' }
      }
      return { ok: true, message: { kind: 'key', name: value.name } }
    }
    case 'text': {
      if (typeof value.text !== 'string') return { ok: false, reason: 'text 必须是字符串' }
      return { ok: true, message: { kind: 'text', text: value.text } }
    }
    case 'visibility': {
      if (typeof value.visible !== 'boolean') return { ok: false, reason: 'visible 必须是 boolean' }
      return { ok: true, message: { kind: 'visibility', visible: value.visible } }
    }
    case 'ping': {
      if (!isFiniteNumber(value.t)) return { ok: false, reason: 't 必须是数字' }
      return { ok: true, message: { kind: 'ping', t: value.t } }
    }
    default:
      return { ok: false, reason: '未知 type: ' + String(value.type) }
  }
}
