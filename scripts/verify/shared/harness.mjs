/**
 * verify 脚本共用工具：子进程执行、断言、步骤输出、无条件清理。
 *
 * 设计目标：
 * - 零第三方依赖（只用 node: 内置模块），可在干净 checkout 直接跑；
 * - 失败必须非零退出并打印足够上下文（stdout/stderr 尾部）；
 * - 临时 profile / 临时 DSH_HOME / 子进程一律经 Cleanup 无条件回收。
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（scripts/verify/lib → ../../..）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** verify 自身的可预期失败（区别于脚本 bug）。 */
export class VerifyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VerifyError'
  }
}

function fail(message) {
  throw new VerifyError(message)
}

export function assert(condition, message) {
  if (!condition) fail(message)
}

export function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    fail(message + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）')
  }
}

export function assertDeepEqual(actual, expected, message) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) fail(message + '（期望 ' + right + '，实际 ' + left + '）')
}

export function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    fail(message + '（未找到 ' + JSON.stringify(needle) + '）')
  }
}

export function assertMatch(value, pattern, message) {
  if (!pattern.test(String(value))) fail(message + '（不匹配 ' + String(pattern) + '）')
}

/** 截取长文本尾部，避免刷屏同时保留失败现场。 */
export function tail(text, max = 4000) {
  const value = String(text ?? '')
  return value.length <= max ? value : '…(截断)…\n' + value.slice(-max)
}

const DEFAULT_TIMEOUT_MS = 300_000

/** 执行命令并收集输出；超时自动 SIGKILL（不抛错，交给 expectSuccess 判定）。 */
export async function run(command, args = [], options = {}) {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolvePromise) => {
    let settled = false
    let timedOut = false
    const stdout = []
    const stderr = []
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? REPO_ROOT,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({
        command,
        args,
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: Date.now() - startedAt,
        spawnError: error,
      })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const settle = (code, signal, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        command,
        args,
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        durationMs: Date.now() - startedAt,
        spawnError,
      })
    }
    child.once('error', (error) => settle(null, null, error))
    child.once('close', (code, signal) => settle(code, signal))
  })
}

/** 断言命令成功；失败时抛出带 stdout/stderr 尾部的 VerifyError。 */
export function expectSuccess(result, label) {
  if (result.spawnError) {
    fail(label + ' 无法启动 ' + result.command + ': ' + result.spawnError.message)
  }
  if (result.timedOut) fail(label + ' 超时（' + result.durationMs + 'ms）')
  if (result.code !== 0) {
    fail(
      label + ' 失败（exit=' + result.code + '）\n--- stdout ---\n' + tail(result.stdout) +
        '\n--- stderr ---\n' + tail(result.stderr),
    )
  }
  return result
}

/** 启动长驻子进程（如临时 web profile），提供等待输出/停止能力。 */
export function spawnManaged(command, args = [], options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  let exit = null
  const exited = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      resolvePromise(exit)
    })
  })
  const text = () => Buffer.concat(stdout).toString('utf8')
  const errors = () => Buffer.concat(stderr).toString('utf8')

  return {
    child,
    stdout: text,
    stderr: errors,
    exited,
    get exitCode() {
      return exit?.code ?? null
    },
    /** 轮询等待 stdout+stderr 出现匹配；超时抛出带现场的错误。 */
    async waitFor(pattern, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const match = pattern.exec(text() + errors())
        if (match) return match
        if (exit !== null) {
          fail(
            '子进程在匹配 ' + String(pattern) + ' 前退出（exit=' + exit.code + '）\n--- stdout ---\n' +
              tail(text()) + '\n--- stderr ---\n' + tail(errors()),
          )
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      }
      fail(
        '等待 ' + String(pattern) + ' 超时（' + timeoutMs + 'ms）\n--- stdout ---\n' + tail(text()) +
          '\n--- stderr ---\n' + tail(errors()),
      )
    },
    /** 优雅停止：SIGTERM → 最多等 10s → SIGKILL；幂等。 */
    async stop({ timeoutMs = 10_000 } = {}) {
      if (exit !== null) return exit
      child.kill('SIGTERM')
      const winner = await Promise.race([
        exited,
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), timeoutMs)),
      ])
      if (winner !== null) return winner
      child.kill('SIGKILL')
      return await exited
    },
  }
}

/** 无条件清理登记表（LIFO）；单个清理失败只告警，不掩盖主失败。 */
export class Cleanup {
  #tasks = []

  constructor() {
    this.#tasks = []
  }

  register(label, task) {
    this.#tasks.push({ label, task, done: false })
    return task
  }

  get pending() {
    return this.#tasks.filter((entry) => !entry.done).length
  }

  async run() {
    while (this.#tasks.length > 0) {
      const entry = this.#tasks.pop()
      if (entry.done) continue
      entry.done = true
      try {
        await entry.task()
        console.log('[cleanup] ✔ ' + entry.label)
      } catch (error) {
        console.error('[cleanup] ✖ ' + entry.label + ': ' + (error?.message ?? error))
      }
    }
  }
}

/** SIGINT/SIGTERM 时先清理再退出，保证不留临时 profile/进程。 */
export function installCleanupSignals(cleanup) {
  let running = false
  const handler = async (signal) => {
    if (running) process.exit(1)
    running = true
    console.error('\n[verify] 收到 ' + signal + '，开始清理…')
    await cleanup.run()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', () => void handler('SIGINT'))
  process.once('SIGTERM', () => void handler('SIGTERM'))
}

/** 步骤输出：开始/耗时/结果；失败时抛给 runScript 统一处理。 */
export async function step(name, body) {
  const startedAt = Date.now()
  console.log('\n[verify] ▶ ' + name)
  try {
    const value = await body()
    console.log('[verify] ✔ ' + name + ' (' + (Date.now() - startedAt) + 'ms)')
    return value
  } catch (error) {
    console.log('[verify] ✖ ' + name + ' (' + (Date.now() - startedAt) + 'ms)')
    throw error
  }
}

/** 脚本统一入口：成功退出 0，失败打印堆栈并退出 1，最后无条件清理。 */
export async function runScript(body, cleanup) {
  installCleanupSignals(cleanup)
  let failed = false
  try {
    await body()
  } catch (error) {
    failed = true
    console.error('\n[verify] FAILED: ' + (error?.stack ?? String(error)))
  } finally {
    await cleanup.run()
  }
  if (failed) {
    console.error('[verify] 结果：失败（退出码 1）')
    process.exitCode = 1
  } else {
    console.log('[verify] 结果：通过')
  }
}

/** 打印一行键值证据（供 docs/verification.md 与 PR 摘录）。 */
export function evidence(label, value) {
  console.log('[evidence] ' + label + ': ' + (typeof value === 'string' ? value : JSON.stringify(value)))
}
