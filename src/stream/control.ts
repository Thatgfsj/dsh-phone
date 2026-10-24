/**
 * scrcpy 控制通道（INJECT_TEXT / INJECT_TOUCH / INJECT_KEYCODE）。
 *
 * SPEC §3.6：中文文本必须走 INJECT_TEXT，禁止 shell `input text`。
 * 本模块不做任何编码转换，只把上层语义映射成 scrcpy control message。
 */

import { AndroidKeyEventAction, AndroidMotionEventAction } from '@yume-chan/scrcpy'
import type { AndroidMotionEventAction as MotionAction, ScrcpyControlMessageWriter } from '@yume-chan/scrcpy'

import type { StreamController, TouchAction } from './types.ts'

/** 协议触摸动作 → Android motion event action。 */
const MOTION_ACTION: Record<TouchAction, MotionAction> = {
  down: AndroidMotionEventAction.Down,
  move: AndroidMotionEventAction.Move,
  up: AndroidMotionEventAction.Up,
}

/** Android keycode 常量（android.view.KeyEvent，source: AOSP KeyEvent.java）。 */
export const KEY_CODES = Object.freeze({
  HOME: 3,
  BACK: 4,
  RECENTS: 187,
  APP_SWITCH: 187,
  ENTER: 66,
  DEL: 67,
  FORWARD_DEL: 112,
  MENU: 82,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  MUTE: 164,
  TAB: 61,
  SPACE: 62,
  ESCAPE: 111,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  CAMERA: 27,
  NOTIFICATION: 83,
  WAKEUP: 224,
  SLEEP: 223,
  MOVE_HOME: 122,
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
} as const)

export type KeyName = keyof typeof KEY_CODES

/** 按键名（大小写不敏感，支持 HOME / home / RECENTS 等）→ keycode。 */
export function resolveKeyCode(name: string): number {
  const normalized = name.trim().toUpperCase()
  const code = (KEY_CODES as Record<string, number | undefined>)[normalized]
  if (code === undefined) {
    throw new RangeError('未知按键名: ' + JSON.stringify(name))
  }
  return code
}

export interface ScreenSize {
  width: number
  height: number
}

/**
 * StreamController 的 scrcpy 实现。
 *
 * writer 为 `undefined`（control 被关闭）时所有注入抛错，由调用方转成 WS error，
 * 不允许静默吞掉——否则用户会看到"点了没反应"。
 */
export class ScrcpyController implements StreamController {
  #writer: ScrcpyControlMessageWriter | undefined
  #screen: ScreenSize
  #device: ScreenSize | undefined

  constructor(writer: ScrcpyControlMessageWriter | undefined, screen: ScreenSize) {
    this.#writer = writer
    this.#screen = { width: screen.width, height: screen.height }
  }

  /** scrcpy 上报视频尺寸变化时更新触摸消息的视频坐标基准。 */
  setScreenSize(width: number, height: number): void {
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      this.#screen = { width, height }
    }
  }

  /** 设备物理分辨率（wm size）；用于把设备坐标换算为 scrcpy 视频坐标。 */
  setDeviceSize(width: number, height: number): void {
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      this.#device = { width, height }
    }
  }

  get deviceSize(): ScreenSize | undefined {
    return this.#device ? { ...this.#device } : undefined
  }

  get screenSize(): ScreenSize {
    return { ...this.#screen }
  }

  #requireWriter(): ScrcpyControlMessageWriter {
    if (!this.#writer) throw new Error('scrcpy 控制通道不可用（control 未启用或会话已结束）')
    return this.#writer
  }

  async injectText(text: string): Promise<void> {
    if (text.length === 0) return
    await this.#requireWriter().injectText(text)
  }

  async injectTouch(action: TouchAction, x: number, y: number): Promise<void> {
    const writer = this.#requireWriter()
    // 面板按「设备坐标」下发（docs/protocol.md §2.3）；scrcpy 的 injectTouch 需要
    // 「视频坐标」+ videoWidth/Height，降采样时按设备/视频比例换算，避免触摸偏移。
    const device = this.#device
    const videoX = device ? (x * this.#screen.width) / device.width : x
    const videoY = device ? (y * this.#screen.height) / device.height : y
    const px = clamp(Math.round(videoX), 0, Math.max(0, this.#screen.width - 1))
    const py = clamp(Math.round(videoY), 0, Math.max(0, this.#screen.height - 1))
    const isUp = action === 'up'
    await writer.injectTouch({
      action: MOTION_ACTION[action],
      pointerId: 0n,
      pointerX: px,
      pointerY: py,
      videoWidth: this.#screen.width,
      videoHeight: this.#screen.height,
      pressure: isUp ? 0 : 1,
      actionButton: 0,
      buttons: isUp ? 0 : 1,
    })
  }

  async injectKey(name: string): Promise<void> {
    const writer = this.#requireWriter()
    const keyCode = resolveKeyCode(name) as Parameters<typeof writer.injectKeyCode>[0]['keyCode']
    await writer.injectKeyCode({
      action: AndroidKeyEventAction.Down,
      keyCode,
      repeat: 0,
      metaState: 0,
    })
    await writer.injectKeyCode({
      action: AndroidKeyEventAction.Up,
      keyCode,
      repeat: 0,
      metaState: 0,
    })
  }

  /** 释放 control writer（stop 时调用；幂等）。 */
  close(): void {
    const writer = this.#writer
    this.#writer = undefined
    if (writer) {
      try {
        writer.releaseLock()
      } catch {
        // writer 已关闭时 releaseLock 可能抛错，忽略。
      }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
