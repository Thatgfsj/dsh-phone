#!/usr/bin/env node
/**
 * 下载并校验 scrcpy-server（固定版本，jar 不提交仓库）。
 *
 * 用法：
 *   node scripts/fetch-scrcpy-server.mjs            # 下载 → 校验 sha256 → assets/scrcpy-server.jar
 *   node scripts/fetch-scrcpy-server.mjs --check    # 只校验已有文件，不联网
 *   node scripts/fetch-scrcpy-server.mjs --force    # 忽略本地缓存重新下载
 *   node scripts/fetch-scrcpy-server.mjs --mirror https://ghproxy.net/  # 追加镜像前缀（可重复）
 *
 * 版本必须与 @yume-chan/scrcpy 的 latest（3.3.3）匹配（docs/calibration.md §6）。
 * 上游许可：Apache-2.0（Genymobile/scrcpy）。jar 被 .gitignore 忽略，不随包发布。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCRCPY_VERSION = '3.3.3'
export const SERVER_ASSET = 'scrcpy-server-v' + SCRCPY_VERSION
export const SERVER_URL =
  'https://github.com/Genymobile/scrcpy/releases/download/v' + SCRCPY_VERSION + '/' + SERVER_ASSET
/** 官方 v3.3.3 release asset 的 sha256（2026-10-25 从 GitHub 官方 URL 下载后计算）。 */
export const SERVER_SHA256 = '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0'
export const SERVER_LICENSE = 'Apache-2.0'
export const DEFAULT_TIMEOUT_MS = 120_000
/** 镜像回退：把官方 URL 作为路径拼在前缀后（未在本机逐个验证，见 docs/stream.md）。 */
export const DEFAULT_MIRRORS = Object.freeze([
  'https://ghproxy.net/',
  'https://ghfast.top/',
])

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_DEST = join(REPO_ROOT, 'assets', 'scrcpy-server.jar')

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 校验文件 sha256；文件不存在返回 ok:false。 */
export async function verifyFile(file, expected = SERVER_SHA256) {
  try {
    const bytes = await readFile(file)
    const actual = sha256Hex(bytes)
    return { ok: actual === expected, actual, size: bytes.byteLength, missing: false }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, actual: '', size: 0, missing: true }
    throw error
  }
}

/** 下载单个 URL → 目标文件（含超时与状态码检查）。 */
export async function downloadTo(url, destination, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText + ' (' + url + ')')
  const bytes = new Uint8Array(await response.arrayBuffer())
  await mkdir(dirname(destination), { recursive: true })
  const temporary = destination + '.download'
  await writeFile(temporary, bytes)
  return { bytes, temporary }
}

/**
 * 从官方 URL + 镜像回退下载并校验；已有文件且校验通过时直接复用。
 * @returns {{ok:true, path:string, sha256:string, size:number, source:string, reused:boolean}}
 */
export async function fetchServer(options = {}) {
  const destination = options.destination ?? DEFAULT_DEST
  const expected = options.expectedSha256 ?? SERVER_SHA256
  const mirrors = options.mirrors ?? DEFAULT_MIRRORS
  const log = options.log ?? ((message) => console.log(message))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!options.force) {
    const existing = await verifyFile(destination, expected)
    if (existing.ok) {
      log('[scrcpy-server] 复用已校验文件: ' + destination)
      return {
        ok: true,
        path: destination,
        sha256: existing.actual,
        size: existing.size,
        source: 'cache',
        reused: true,
      }
    }
  }

  const candidates = [SERVER_URL, ...mirrors.map((prefix) => prefix + SERVER_URL)]
  const errors = []
  for (const url of candidates) {
    let temporary
    try {
      log('[scrcpy-server] 下载: ' + url)
      const result = await downloadTo(url, destination, { timeoutMs })
      temporary = result.temporary
      const actual = sha256Hex(result.bytes)
      if (actual !== expected) {
        throw new Error('sha256 校验失败: ' + actual + ' != ' + expected)
      }
      await rename(temporary, destination)
      log('[scrcpy-server] 完成: ' + destination + ' (' + result.bytes.byteLength + ' bytes)')
      return {
        ok: true,
        path: destination,
        sha256: actual,
        size: result.bytes.byteLength,
        source: url,
        reused: false,
      }
    } catch (error) {
      errors.push(url + ': ' + (error instanceof Error ? error.message : String(error)))
      if (temporary) await rm(temporary, { force: true })
      log('[scrcpy-server] 失败，尝试下一个来源: ' + errors.at(-1))
    }
  }
  throw new Error('所有下载来源均失败:\n  ' + errors.join('\n  '))
}

/** 只校验本地文件（--check）。 */
export async function checkServer(options = {}) {
  const destination = options.destination ?? DEFAULT_DEST
  const expected = options.expectedSha256 ?? SERVER_SHA256
  const result = await verifyFile(destination, expected)
  if (result.missing) {
    return {
      ok: false,
      message: '缺少 ' + destination + '；运行 node scripts/fetch-scrcpy-server.mjs 下载',
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      message: 'sha256 不匹配: 实际 ' + result.actual + '，期望 ' + expected,
    }
  }
  return { ok: true, message: '校验通过: ' + destination + ' (' + result.size + ' bytes)' }
}

export function parseArgs(argv) {
  const options = { check: false, force: false, destination: DEFAULT_DEST, mirrors: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--force') options.force = true
    else if (arg === '--out') {
      const value = argv[index + 1]
      if (!value) throw new Error('--out 需要一个路径')
      options.destination = resolve(value)
      index += 1
    } else if (arg === '--mirror') {
      const value = argv[index + 1]
      if (!value) throw new Error('--mirror 需要一个 URL 前缀')
      options.mirrors.push(value.endsWith('/') ? value : value + '/')
      index += 1
    } else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error('未知参数: ' + arg)
  }
  return options
}

function usage() {
  console.log(
    [
      '用法: node scripts/fetch-scrcpy-server.mjs [--check] [--force] [--out <path>] [--mirror <url-prefix>]',
      '',
      '  --check   只校验本地 assets/scrcpy-server.jar，不下载',
      '  --force   忽略本地缓存，重新下载',
      '  --out     自定义目标路径（默认 assets/scrcpy-server.jar）',
      '  --mirror  追加镜像前缀（可重复；默认含 ghproxy.net/ghfast.top）',
      '',
      'scrcpy-server v' + SCRCPY_VERSION + ' · sha256 ' + SERVER_SHA256 + ' · ' + SERVER_LICENSE,
    ].join('\n'),
  )
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    usage()
    return 0
  }
  if (options.check) {
    const result = await checkServer(options)
    if (!result.ok) {
      console.error('[scrcpy-server] ' + result.message)
      return 1
    }
    console.log('[scrcpy-server] ' + result.message)
    return 0
  }
  try {
    const result = await fetchServer({
      destination: options.destination,
      force: options.force,
      mirrors: DEFAULT_MIRRORS.concat(options.mirrors),
    })
    console.log('[scrcpy-server] sha256 ' + result.sha256 + ' · ' + result.size + ' bytes')
    return 0
  } catch (error) {
    console.error('[scrcpy-server] ' + (error instanceof Error ? error.message : String(error)))
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}
