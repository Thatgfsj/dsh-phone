#!/usr/bin/env node
/**
 * verify-all：一条命令跑完 dsh-phone 验收矩阵（`npm run verify`）。
 *
 * 顺序：工具注册 → WS 协议 → 临时 profile 安装冒烟 → e2e（带 skip 原因）。
 * 每个子脚本独立可跑；任一失败整体非零退出。输出直接继承终端，便于贴 PR。
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, run } from './shared/harness.mjs'

const STEP_TIMEOUT_MS = 600_000

/** 子进程用继承 stdio，输出实时可见；超时 SIGKILL 而非无限挂起。 */
function runInherit(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: 'inherit',
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? STEP_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: null, error, timedOut, durationMs: Date.now() - startedAt })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, timedOut, durationMs: Date.now() - startedAt })
    })
  })
}

async function header() {
  console.log('='.repeat(72))
  console.log('dsh-phone 验收矩阵（npm run verify）')
  console.log('='.repeat(72))
  const dsh = await run('dsh', ['--version'], { timeoutMs: 60_000 })
  const versions = {
    node: process.version,
    platform: process.platform + '/' + process.arch,
    dsh: dsh.code === 0 ? dsh.stdout.trim() : '不可用（' + (dsh.spawnError?.message ?? dsh.code) + '）',
  }
  for (const [key, value] of Object.entries(versions)) console.log('  ' + key.padEnd(8) + value)
  console.log('  repo    ' + REPO_ROOT)
  console.log('')
}

const results = []

async function scenario(name, command, args, options = {}) {
  console.log('\n' + '─'.repeat(72))
  console.log('▶ ' + name)
  console.log('─'.repeat(72))
  const result = await runInherit(command, args, options)
  const ok = result.code === 0
  results.push({ name, ok, durationMs: result.durationMs, code: result.code, timedOut: result.timedOut })
  console.log((ok ? '✔ ' : '✖ ') + name + ' (' + (result.durationMs / 1000).toFixed(1) + 's)')
  return ok
}

await header()

await scenario('工具注册与 phone_shell 审批（verify-tools）', 'node', [
  join('scripts', 'verify', 'verify-tools.mjs'),
])
await scenario('WS 协议 / DPH1 / 5s 宽限（verify-stream）', 'node', [
  join('scripts', 'verify', 'verify-stream.mjs'),
])
await scenario('临时 profile 安装冒烟（verify-install）', 'node', [
  join('scripts', 'verify', 'verify-install.mjs'),
])
await scenario('单文件行数（≤1000 硬线）', 'node', ['scripts/check-file-lines.mjs'])
const e2eDir = join(REPO_ROOT, 'tests', 'e2e')
const e2eFiles = readdirSync(e2eDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(e2eDir, name))
await scenario('e2e 矩阵（无真机/容器/浏览器，全部带 skip 原因）', 'node', ['--test', ...e2eFiles])

console.log('\n' + '='.repeat(72))
console.log('汇总')
console.log('='.repeat(72))
let failed = 0
for (const result of results) {
  const state = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  const detail = result.timedOut ? ' (timeout)' : result.code !== 0 ? ' (exit ' + result.code + ')' : ''
  console.log('  ' + state.padEnd(5) + result.name + detail)
}
console.log('')
if (failed > 0) {
  console.error('验收失败：' + failed + '/' + results.length + ' 项未通过')
  process.exitCode = 1
} else {
  console.log('验收通过：' + results.length + '/' + results.length + ' 项（skip 项见上方 e2e 输出与 docs/verification.md）')
}
