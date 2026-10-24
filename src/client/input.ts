/**
 * Pointer/keyboard translation between the panel and device coordinates.
 *
 * Kept pure so the coordinate math (which is easy to get subtly wrong under
 * letterboxing + devicePixelRatio) is unit-tested without a DOM.
 */

export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

/** The letterboxed rectangle an aspect-fitted video occupies inside `box`. */
export function fitRect(box: Size, content: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || content.width <= 0 || content.height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const scale = Math.min(box.width / content.width, box.height / content.height)
  const width = content.width * scale
  const height = content.height * scale
  return {
    left: (box.width - width) / 2,
    top: (box.height - height) / 2,
    width,
    height,
  }
}

/**
 * Translate a pointer position (relative to the canvas box, in CSS pixels) to
 * device pixel coordinates, clamped to the device edges.
 * @param pointer - position relative to the canvas element.
 * @param box - canvas CSS size.
 * @param device - device framebuffer size.
 * @returns integer device coordinates.
 */
export function mapPointerToDevice(pointer: Point, box: Size, device: Size): Point {
  const rect = fitRect(box, device)
  const x = rect.width === 0 ? 0 : ((pointer.x - rect.left) / rect.width) * device.width
  const y = rect.height === 0 ? 0 : ((pointer.y - rect.top) / rect.height) * device.height
  const clampX = Math.min(device.width - 1, Math.max(0, x))
  const clampY = Math.min(device.height - 1, Math.max(0, y))
  return { x: Math.round(clampX), y: Math.round(clampY) }
}

/** Keyboard shortcuts forwarded to the device while the canvas has focus. */
export const KEY_SHORTCUTS: Readonly<Record<string, string>> = {
  Escape: 'BACK',
  Enter: 'ENTER',
  Backspace: 'DEL',
  Delete: 'DEL',
  Home: 'HOME',
  App: 'RECENTS',
}

/** Map a DOM keyboard event key to a device key name, if we forward it. */
export function mapKeyboardKey(key: string): string | undefined {
  return KEY_SHORTCUTS[key]
}

/** Device key buttons rendered under the panel canvas (label keys are i18n ids). */
export const KEY_BUTTONS: readonly {
  name: 'HOME' | 'BACK' | 'RECENTS' | 'ENTER' | 'DEL'
  label: string
}[] = [
  { name: 'HOME', label: 'panel.keys.home' },
  { name: 'BACK', label: 'panel.keys.back' },
  { name: 'RECENTS', label: 'panel.keys.recents' },
  { name: 'ENTER', label: 'panel.keys.enter' },
  { name: 'DEL', label: 'panel.keys.del' },
]
