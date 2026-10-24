#!/usr/bin/env node
/**
 * 单文件行数硬线检查（阈值默认 1000 行）。
 *
 * 仓库规则：任何代码/文档文件不得超过 1000 行，超过必须停下交用户决定
 * （见 CONTRIBUTING.md）；日常目标每文件 <= 300 行。
 *
 * 用法：
 *   node scripts/check-file-lines.mjs             # 扫描 src/ tests/ scripts/
 *   node scripts/check-file-lines.mjs --limit 500 # 自定义阈值
 *   node scripts/check-file-lines.mjs src docs    # 只扫指定目录
 *
 * 退出码：0 通过；1 存在超限文件；2 参数错误。
 * 排除目录：node_modules lib dist coverage .git .worktrees .nyc_output
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultLimit = 1000
const defaultRoots = ['src', 'tests', 'scripts']
const extensions = new Set(['.ts', '.mjs', '.js', '.md'])
const skipDirs = new Set(['node_modules', 'lib', 'dist', 'coverage', '.git', '.worktrees', '.nyc_output'])

function usage() {
  console.log(
    [
      '用法: node scripts/check-file-lines.mjs [--limit <n>] [目录...]',
      '',
      '默认扫描 src/ tests/ scripts/ 下的 .ts / .mjs / .js / .md 文件；',
      '单文件超过 ' + defaultLimit + ' 行（或 --limit 指定值）即非零退出。',
    ].join('\n'),
  )
}

function parseArgs(argv) {
  const roots = []
  let limit = defaultLimit
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--limit' || arg === '-l') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--limit 需要一个正整数参数')
      limit = Number(value)
      i += 1
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length))
    } else if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg.startsWith('-')) {
      throw new Error('未知参数: ' + arg)
    } else {
      roots.push(arg)
    }
  }
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit 必须是正整数')
  return { limit, roots: roots.length > 0 ? roots : defaultRoots }
}

async function collectFiles(dir, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      await collectFiles(path, out)
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      out.push(path)
    }
  }
}

async function countLines(path) {
  const text = await readFile(path, 'utf8')
  if (text.length === 0) return 0
  let lines = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1
  }
  if (!text.endsWith('\n')) lines += 1
  return lines
}

async function main() {
  const { limit, roots } = parseArgs(process.argv.slice(2))
  const files = []
  for (const root of roots) {
    await collectFiles(resolve(repoRoot, root), files)
  }
  files.sort()

  const overLimit = []
  for (const file of files) {
    const lines = await countLines(file)
    if (lines > limit) overLimit.push({ file: relative(repoRoot, file), lines })
  }

  if (overLimit.length > 0) {
    overLimit.sort((a, b) => b.lines - a.lines)
    for (const item of overLimit) {
      console.error('  x ' + item.file + '  ' + item.lines + ' 行 (上限 ' + limit + ')')
    }
    console.error(
      '[check-file-lines] 失败: ' +
        overLimit.length +
        ' 个文件超过 ' +
        limit +
        ' 行；超过 1000 行必须交用户决定。',
    )
    process.exitCode = 1
    return
  }

  console.log('[check-file-lines] 通过: ' + files.length + ' 个文件，上限 ' + limit + ' 行')
}

try {
  await main()
} catch (error) {
  console.error('[check-file-lines] ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 2
}
