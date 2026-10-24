/** 假 AdbConnection：记录设备命令并按规则返回结果，用于 device.ts 单测。 */

import type { Adb } from '@yume-chan/adb'

import type {
  AdbConnection,
  Endpoint,
  PushOptions,
  ShellOptions,
} from '../../src/adb/types.ts'
import { AdbError } from '../../src/adb/types.ts'

export type FakeShellResponse =
  | string
  | Uint8Array
  | Error
  | ((command: string) => string | Uint8Array | Error)

export class FakeAdbConnection implements AdbConnection {
  readonly endpoint: Endpoint = { host: '127.0.0.1', port: 5555 }
  readonly serial = 'fake-serial'
  readonly disconnected = new Promise<void>(() => undefined)
  readonly raw = {} as Adb
  readonly commands: string[] = []
  readonly pushes: { path: string; data: Uint8Array }[] = []
  readonly #routes: { match: RegExp; response: FakeShellResponse }[] = []

  /** 注册命令响应（后注册的优先）。 */
  on(match: RegExp, response: FakeShellResponse): this {
    this.#routes.unshift({ match, response })
    return this
  }

  async shell(command: string, _options?: ShellOptions): Promise<string> {
    const result = this.#resolve(command)
    return typeof result === 'string' ? result : new TextDecoder().decode(result)
  }

  async shellRaw(command: string, _options?: ShellOptions): Promise<Uint8Array> {
    const result = this.#resolve(command)
    return typeof result === 'string' ? new TextEncoder().encode(result) : result
  }

  async push(
    local: Uint8Array,
    remotePath: string,
    _options?: PushOptions,
  ): Promise<void> {
    this.pushes.push({ path: remotePath, data: local })
  }

  async close(): Promise<void> {}

  #resolve(command: string): string | Uint8Array {
    this.commands.push(command)
    for (const route of this.#routes) {
      if (!route.match.test(command)) continue
      const response =
        typeof route.response === 'function' ? route.response(command) : route.response
      if (response instanceof Error) throw response
      return response
    }
    throw new AdbError(`假连接未注册命令: ${command}`, 'shell')
  }
}
