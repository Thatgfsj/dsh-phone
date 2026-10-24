/**
 * ADB 认证密钥仓库（Node 端）。
 *
 * Tango ADB 需要一个 `AdbCredentialStore` 才能完成 adbd 的 AUTH 握手。
 * 默认沿用标准 adb 密钥路径 `~/.android/adbkey`（PKCS#8 DER）：
 * - 若用户本机已经用过 adb，设备上很可能已授权该公钥，可直接连上；
 * - 若不存在，首次连接时生成 RSA-2048 并落盘（0600），设备会弹授权框。
 *
 * 注意：这里只读写密钥文件，不调用任何 adb 二进制（SPEC §3.2）。
 */

import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AdbCredentialStore, AdbPrivateKey } from '@yume-chan/adb'

export interface FileCredentialStoreOptions {
  /** 密钥目录，默认 `~/.android`。 */
  dir?: string
  /** 私钥文件名，默认 `adbkey`。 */
  fileName?: string
}

export interface FileCredentialStore extends AdbCredentialStore {
  /** 当前使用的私钥文件绝对路径。 */
  readonly keyPath: string
}

function defaultCredentialDir(): string {
  return join(homedir(), '.android')
}

export function createFileCredentialStore(
  options: FileCredentialStoreOptions = {},
): FileCredentialStore {
  const dir = options.dir ?? defaultCredentialDir()
  const keyPath = join(dir, options.fileName ?? 'adbkey')

  let generating: Promise<AdbPrivateKey> | undefined

  async function generate(): Promise<AdbPrivateKey> {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const der = privateKey.export({ type: 'pkcs8', format: 'der' })
    const buffer = new Uint8Array(der.byteOffset === 0 ? der : der.slice(0))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(keyPath, buffer, { mode: 0o600 })
    await chmod(keyPath, 0o600).catch(() => undefined)
    return { buffer, name: 'dsh-phone' }
  }

  return {
    keyPath,

    async *iterateKeys(): AsyncIterable<AdbPrivateKey> {
      let data: Uint8Array
      try {
        data = new Uint8Array(await readFile(keyPath))
      } catch {
        return
      }
      if (data.length === 0) return
      yield { buffer: data, name: 'dsh-phone' }
    },

    generateKey(): Promise<AdbPrivateKey> {
      generating ??= generate()
      return generating
    },
  }
}

let sharedStore: FileCredentialStore | undefined

/** 进程级默认密钥仓库（惰性创建）。 */
export function getDefaultCredentialStore(): FileCredentialStore {
  sharedStore ??= createFileCredentialStore()
  return sharedStore
}
