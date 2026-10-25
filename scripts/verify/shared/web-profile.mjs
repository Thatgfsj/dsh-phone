/**
 * 真实 e2e 用的临时 web profile（隔离 DSH_HOME，不碰用户 web/headless profile）。
 *
 * 流程：npm run build → 临时 DSH_HOME 里用 web 模板初始化 phone-e2e profile →
 * dsh plugin add . 装当前构建 → 写临时用户层（onboarding/config）→ 起 web
 * （--no-open --port 0）→ 用启动 URL 的浏览器 token 换同源 cookie。
 *
 * 所有清理由调用方传入的 Cleanup 统一登记（LIFO）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  REPO_ROOT,
  assert,
  assertEqual,
  expectSuccess,
  run,
  spawnManaged,
} from './harness.mjs'

export const E2E_PROFILE = 'phone-e2e'
export const USER_3080 = 'http://127.0.0.1:3080'

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 干净 checkout 首次运行：node_modules 缺失则 npm install；随后总是 build（lib/ 不入库）。 */
export async function ensureBuild() {
  if (!existsSync(join(REPO_ROOT, 'node_modules', 'esbuild'))) {
    expectSuccess(
      await run('npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 600_000 }),
      'npm install',
    )
  }
  const build = expectSuccess(await run('npm', ['run', 'build'], { timeoutMs: 180_000 }), 'npm run build')
  assert(existsSync(join(REPO_ROOT, 'lib', 'index.js')), 'build 后缺少 lib/index.js')
  assert(existsSync(join(REPO_ROOT, 'lib', 'client.js')), 'build 后缺少 lib/client.js')
  return build.stdout.trim().split('\n').at(-1) ?? 'build ok'
}

/**
 * 写临时 profile 的用户层（只存在于隔离 home，随 home 删除）。
 * configLines 是 dsh-phone.config 下的 YAML 行（不含缩进）。
 */
export function writeUserLayer(profileDir, configLines) {
  const patchFile = join(profileDir, 'cordis.patch.yml')
  // initProfile 的模板是注释 + 空列表 []；必须先移除空列表再追加顶层数组条目。
  const kept = readFileSync(patchFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '[]')
    .join('\n')
    .trimEnd()
  const body = [
    kept,
    '',
    '# e2e 临时用户层（仅存在于隔离临时 profile，随 home 删除）',
    '- id: dsh-phone',
    '  config:',
    ...configLines.map((line) => (line === '' ? '' : '    ' + line)),
    '',
  ].join('\n')
  writeFileSync(patchFile, body)
}

/** 同源浏览器 cookie（启动 URL 的 token 换来的 dsh-auth-*）。 */
export async function login(origin, browserToken) {
  const response = await fetch(origin + '/?token=' + browserToken, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  })
  assertEqual(response.status, 303, '启动 URL 的浏览器 token 应 303 下发同源 cookie')
  const setCookies = response.headers.getSetCookie?.() ?? []
  const cookie = setCookies.map((value) => value.split(';')[0]).find((value) => value.startsWith('dsh-auth-'))
  assert(cookie !== undefined, '浏览器 token 未下发 dsh-auth-* cookie')
  return cookie
}

/**
 * 创建并启动隔离临时 web profile，返回连接所需上下文。
 *
 * options.cleanup 由调用方提供；options.configLines 是 dsh-phone.config 的 YAML 行。
 */
export async function createWebProfile({ cleanup, configLines, profile = E2E_PROFILE }) {
  const buildLine = await ensureBuild()
  const home = mkdtempSync(join(tmpdir(), 'dsh-phone-e2e-'))
  cleanup.register('删除隔离 DSH_HOME ' + home, () => rmSync(home, { recursive: true, force: true }))
  const env = { ...process.env, DSH_HOME: home }
  const dsh = (args, options = {}) =>
    run('dsh', args, { cwd: REPO_ROOT, env, timeoutMs: options.timeoutMs ?? 180_000 })

  expectSuccess(
    await dsh(['--profile', profile, '--from-default-profile', 'web', '--dump-config']),
    '初始化临时 web profile',
  )
  expectSuccess(await dsh(['plugin', '--profile', profile, 'add', '.']), '安装 dsh-phone 到临时 profile')
  writeUserLayer(join(home, 'profiles', profile), configLines)

  const web = spawnManaged('dsh', ['--profile', profile, '--no-open', '--port', '0'], { env })
  cleanup.register('停止临时 web 进程', async () => {
    await web.stop({ timeoutMs: 10_000 })
  })
  const match = await web.waitFor(
    /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/,
    120_000,
  )
  const origin = 'http://127.0.0.1:' + match[2]
  assert(origin !== USER_3080, 'e2e 不得复用用户正在使用的 3080 实例')

  const cookie = await login(origin, match[3])
  const tokenFile = join(home, 'storages', 'dsh-phone', 'agent.json')
  assert(existsSync(tokenFile), 'apply 后应生成 agent.json（本地 Agent 通道凭据）')
  const agent = readJson(tokenFile)
  assertEqual(agent.baseUrl, origin, 'agent.json.baseUrl 必须等于实际监听 origin')
  assert(/^[0-9a-f]{64}$/.test(agent.token), 'agent.json.token 必须是 64 位十六进制')

  return { home, env, origin, cookie, agentToken: agent.token, web, profile, buildLine }
}

/** fetch + JSON 解析（统一 5s/可覆盖超时）。 */
export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { response, body, text }
}

export function isPng(bytes) {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  )
}
