/**
 * 设备语义层：截图 / 点击 / 滑动 / 按键 / 启动应用 / 控件树。
 *
 * 全部通过设备端 shell 执行，**不使用宿主机 adb 二进制**（SPEC §3.2）。
 * 中文文本注入**不在这里**：`input text` 只支持 ASCII，必须走 stream 层的
 * scrcpy 控制通道 INJECT_TEXT（SPEC §4、INTERFACES §2）。
 */

import { AdbError } from './types.ts'
import type { AdbConnection, ShellOptions } from './types.ts'

/** 截图/控件树临时文件目录（设备端）。 */
const DEVICE_TMP_DIR = '/sdcard'
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 30_000
const DEFAULT_DUMP_TIMEOUT_MS = 30_000

/** 常用按键名 → Android keyevent 名。 */
export const KEY_NAMES = {
  HOME: 'KEYCODE_HOME',
  BACK: 'KEYCODE_BACK',
  RECENTS: 'KEYCODE_APP_SWITCH',
  APP_SWITCH: 'KEYCODE_APP_SWITCH',
  MENU: 'KEYCODE_MENU',
  ENTER: 'KEYCODE_ENTER',
  DEL: 'KEYCODE_DEL',
  DELETE: 'KEYCODE_DEL',
  ESCAPE: 'KEYCODE_ESCAPE',
  TAB: 'KEYCODE_TAB',
  SPACE: 'KEYCODE_SPACE',
  POWER: 'KEYCODE_POWER',
  WAKEUP: 'KEYCODE_WAKEUP',
  SLEEP: 'KEYCODE_SLEEP',
  VOLUME_UP: 'KEYCODE_VOLUME_UP',
  VOLUME_DOWN: 'KEYCODE_VOLUME_DOWN',
  VOLUME_MUTE: 'KEYCODE_VOLUME_MUTE',
  CAMERA: 'KEYCODE_CAMERA',
  NOTIFICATION: 'KEYCODE_NOTIFICATION',
  SEARCH: 'KEYCODE_SEARCH',
} as const

export type KeyName = keyof typeof KEY_NAMES

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

function decodeBase64(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, '')
  if (!compact) return new Uint8Array(0)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new AdbError('设备返回的 base64 内容非法（可能混入了错误输出）', 'protocol')
  }
  const buffer = Buffer.from(compact, 'base64')
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function requireInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new AdbError(`${name} 必须是非负整数，收到: ${String(value)}`, 'protocol')
  }
  return value
}

function keyEventFor(name: string): string {
  const normalized = name.trim().toUpperCase()
  if (!normalized) throw new AdbError('按键名不能为空', 'protocol')
  if (/^\d+$/.test(normalized)) return normalized
  if (normalized.startsWith('KEYCODE_')) return normalized
  const mapped = KEY_NAMES[normalized as KeyName]
  return mapped ?? `KEYCODE_${normalized}`
}

export interface AdbDeviceOptions {
  /** 临时文件前缀，默认 `/sdcard/.dsh-phone-`。 */
  tmpPrefix?: string
  defaultTimeoutMs?: number
}

/**
 * 设备操作门面。所有方法都依赖 {@link AdbConnection} 的 shell 能力；
 * 测试可直接注入假的 `AdbConnection`。
 */
export class AdbDevice {
  readonly connection: AdbConnection
  readonly #tmpPrefix: string
  readonly #defaultTimeoutMs: number
  #sequence = 0

  constructor(connection: AdbConnection, options: AdbDeviceOptions = {}) {
    this.connection = connection
    this.#tmpPrefix = options.tmpPrefix ?? `${DEVICE_TMP_DIR}/.dsh-phone-`
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS
  }

  /** 生成设备端唯一临时路径（避免并发截图互相覆盖）。 */
  tempPath(extension: string): string {
    this.#sequence = (this.#sequence + 1) % 1_000_000
    return `${this.#tmpPrefix}${Date.now()}-${process.pid}-${this.#sequence}.${extension}`
  }

  async shell(command: string, options: ShellOptions = {}): Promise<string> {
    return this.connection.shell(command, options)
  }

  /**
   * 截屏：`screencap -p` 落到设备临时文件 → `base64` 取回 → 删除临时文件。
   * 返回 PNG 原始字节（供 phone_screenshot / WS 图像通道）。
   */
  async screenshot(options: { timeoutMs?: number } = {}): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs
    const path = this.tempPath('png')
    try {
      await this.connection.shell(`screencap -p ${path}`, { timeoutMs })
      const base64 = await this.connection.shell(`base64 ${path}`, { timeoutMs })
      const bytes = decodeBase64(base64)
      if (!isPng(bytes)) {
        throw new AdbError(
          `screencap 返回内容不是有效 PNG（${bytes.length} 字节）`,
          'protocol',
        )
      }
      return bytes
    } finally {
      await this.connection
        .shell(`rm -f ${path}`, { timeoutMs: 5_000 })
        .catch(() => undefined)
    }
  }

  async tap(x: number, y: number, options: ShellOptions = {}): Promise<void> {
    requireInteger(x, 'x')
    requireInteger(y, 'y')
    await this.connection.shell(`input tap ${x} ${y}`, options)
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300,
    options: ShellOptions = {},
  ): Promise<void> {
    requireInteger(x1, 'x1')
    requireInteger(y1, 'y1')
    requireInteger(x2, 'x2')
    requireInteger(y2, 'y2')
    requireInteger(durationMs, 'durationMs')
    await this.connection.shell(
      `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`,
      options,
    )
  }

  /** 标准 keyevent（HOME/BACK/RECENTS/ENTER/DEL...，也接受数字 keycode）。 */
  async key(name: string, options: ShellOptions = {}): Promise<void> {
    await this.connection.shell(`input keyevent ${keyEventFor(name)}`, options)
  }

  /** 按包名启动应用（monkey 方式，不要求 Activity 名）。 */
  async appLaunch(pkg: string, options: ShellOptions = {}): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(pkg)) {
      throw new AdbError(`包名非法: ${pkg}`, 'protocol')
    }
    await this.connection.shell(
      `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
      options,
    )
  }

  /** uiautomator dump → cat 取回 XML 文本（临时文件随后删除）。 */
  async dumpUi(options: { timeoutMs?: number } = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_DUMP_TIMEOUT_MS
    const path = this.tempPath('xml')
    try {
      await this.connection.shell(`uiautomator dump ${path}`, { timeoutMs })
      const xml = await this.connection.shell(`cat ${path}`, { timeoutMs })
      if (!xml.includes('<hierarchy')) {
        throw new AdbError('uiautomator dump 返回内容不是有效控件树', 'protocol')
      }
      return xml
    } finally {
      await this.connection
        .shell(`rm -f ${path}`, { timeoutMs: 5_000 })
        .catch(() => undefined)
    }
  }
}
