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
/**
 * 冷启动窗口内截图重试（issue #44）：adbd 可连但系统未 boot_completed 时，
 * screencap/base64 可能返回空或错误文本。首次失败后再试，共 3 次。
 */
const DEFAULT_SCREENSHOT_ATTEMPTS = 3
const DEFAULT_SCREENSHOT_RETRY_DELAY_MS = 500

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

function deviceNotReady(message: string, cause?: unknown): AdbError {
  return new AdbError('E_DEVICE_NOT_READY: ' + message, 'device-not-ready', {
    cause,
    retryable: true,
  })
}

function decodeBase64(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, '')
  if (!compact) {
    throw deviceNotReady('截图输出为空（设备可能仍在开机/锁屏，稍后重试）')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw deviceNotReady('截图输出不是合法 base64（设备可能仍在开机，输出尚未就绪）')
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

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    timer.unref?.()
  })
}

function isRetryableCaptureError(error: AdbError): boolean {
  return (
    error.retryable ||
    error.code === 'device-not-ready' ||
    error.code === 'protocol' ||
    error.code === 'timeout' ||
    error.code === 'closed'
  )
}

export interface ScreenshotOptions {
  timeoutMs?: number
  /** 总尝试次数（含首次），默认 3。 */
  attempts?: number
  /** 重试基础延迟（第 n 次重试等待 n * retryDelayMs），默认 500ms。 */
  retryDelayMs?: number
  /** 注入 sleep（单测用）。 */
  sleep?(delayMs: number): Promise<void>
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
  async screenshot(options: ScreenshotOptions = {}): Promise<Uint8Array> {
    const attempts = Math.max(1, options.attempts ?? DEFAULT_SCREENSHOT_ATTEMPTS)
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_SCREENSHOT_RETRY_DELAY_MS
    const sleep = options.sleep ?? defaultSleep
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs
    let lastError: AdbError | undefined
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#captureOnce(timeoutMs)
      } catch (error) {
        const failure =
          error instanceof AdbError
            ? error
            : new AdbError('截图失败: ' + String(error), 'shell', { cause: error })
        lastError = failure
        if (attempt >= attempts || !isRetryableCaptureError(failure)) {
          break
        }
        // 冷启动窗口内首次失败多为设备未就绪：退避后重试
        await sleep(retryDelayMs * attempt)
      }
    }
    throw deviceNotReady(
      '连续 ' + attempts + ' 次截图失败（' + (lastError?.message ?? '未知原因') + '），稍后重试',
      lastError,
    )
  }

  /** 单次截图尝试：screencap 落盘 → base64 取回 → 删除临时文件。 */
  async #captureOnce(timeoutMs: number): Promise<Uint8Array> {
    const path = this.tempPath('png')
    try {
      await this.connection.shell('screencap -p ' + path, { timeoutMs })
      const base64 = await this.connection.shell('base64 ' + path, { timeoutMs })
      const bytes = decodeBase64(base64)
      if (!isPng(bytes)) {
        throw deviceNotReady('screencap 输出不是有效 PNG（' + bytes.length + ' 字节）')
      }
      return bytes
    } finally {
      await this.connection
        .shell('rm -f ' + path, { timeoutMs: 5_000 })
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
