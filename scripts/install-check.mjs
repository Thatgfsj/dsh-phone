#!/usr/bin/env node
/**
 * dsh-phone 安装自检（#74）：一条命令校验 profile 里的四项安装状态，并给出修复建议。
 *
 * 检查项（顺序执行，互不阻断）：
 *   1. dependency    profile package.json 的 dependencies 是否含 dsh-phone
 *   2. bundles       dsh.profile.bundles 是否含 dsh-phone（缺了它 --dump-config 就没有插件行）
 *   3. dump-config   dsh --profile <p> --dump-config 是否真的组合出 dsh-phone 行
 *   4. API           运行中的 DSH 是否响应 GET /dsh-phone/api/status（需要 web profile + 本地 Agent token）
 *
 * 用法：
 *   node scripts/install-check.mjs                       # 默认检查 web profile
 *   node scripts/install-check.mjs --profile phone-test
 *   node scripts/install-check.mjs --base-url http://127.0.0.1:3080 --token <agent-token>
 *   node scripts/install-check.mjs --json                # 机器可读输出（CI）
 *   node scripts/install-check.mjs --strict-api          # API 检查不可用也算失败
 *
 * 退出码：0 = 无失败（API 未运行算 skip）；1 = 有失败；2 = 参数/环境错误。
 * 只读：不修改 profile、不启动/重启 DSH、不写配置文件。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const PACKAGE_NAME = 'dsh-phone'
const API_PATH = '/dsh-phone/api/status'

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'web' },
    'base-url': { type: 'string' },
    token: { type: 'string' },
    json: { type: 'boolean', default: false },
    'strict-api': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help) {
  console.log(
    [
      '用法: node scripts/install-check.mjs [--profile <name>] [--base-url <url>] [--token <token>] [--json] [--strict-api]',
      '',
      '校验 profile 中 dsh-phone 的四项安装状态：dependency / bundles / dump-config / API。',
      'API 检查需要运行中的 DSH web 与本地 Agent token（缺省自动读 $DSH_HOME/storages/dsh-phone/agent.json）。',
    ].join('\n'),
  )
  process.exit(0)
}

const profile = values.profile
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const tokenFile = join(dshHome, 'storages', PACKAGE_NAME, 'agent.json')

const results = []

function record(id, title, status, detail, fix) {
  results.push({ id, title, status, detail, fix })
}

function fail(id, title, detail, fix) {
  record(id, title, 'fail', detail, fix)
}

function pass(id, title, detail) {
  record(id, title, 'pass', detail)
}

function skip(id, title, detail, fix) {
  record(id, title, 'skip', detail, fix)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readAgentToken() {
  if (!existsSync(tokenFile)) return undefined
  try {
    return readJson(tokenFile)
  } catch {
    return undefined
  }
}

function tail(text, maxLines) {
  const lines = String(text ?? '').trim().split('\n').filter(Boolean)
  return lines.slice(-maxLines).join('\n')
}

/* ------------------------------ 1. dependency ------------------------------ */
function checkDependency(manifest) {
  const spec = manifest.dependencies?.[PACKAGE_NAME]
  if (typeof spec === 'string' && spec.length > 0) {
    pass('dependency', 'profile 依赖', PACKAGE_NAME + ' = ' + spec)
  } else {
    fail(
      'dependency',
      'profile 依赖',
      'profile ' + profile + ' 的 dependencies 里没有 ' + PACKAGE_NAME,
      '安装到该 profile：dsh plugin --profile ' + profile + ' add <release-tgz 路径或 git URL>（详见 docs/install.md）',
    )
  }
}

/* -------------------------------- 2. bundles -------------------------------- */
function checkBundles(manifest) {
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
    pass('bundles', 'profile bundle 层', 'dsh.profile.bundles 已包含 ' + PACKAGE_NAME)
    return
  }
  fail(
    'bundles',
    'profile bundle 层',
    'dsh.profile.bundles 缺少 ' + PACKAGE_NAME + '（dependency 有、bundle 缺 = 半安装：Host 不加载插件，--dump-config 无行，API 404）',
    [
      '修复 A（推荐）：打开 DSH「设置 → 插件」，在已安装插件里启用 ' + PACKAGE_NAME + '（等价于写回 bundles），然后重启 DSH 并刷新页面。',
      '修复 B：编辑 ' + manifestPath + '，把 "' + PACKAGE_NAME + '" 加进 dsh.profile.bundles 数组，保存后重启 DSH 并刷新页面。',
      '注意：重跑 dsh plugin add 不会自动补 bundles（已存在的 dependency 会被 reconcile 跳过）。',
    ].join('\n'),
  )
}

/* ------------------------------ 3. dump-config ------------------------------ */
function checkDumpConfig() {
  const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    fail('dump-config', 'dsh --dump-config', '无法执行 dsh: ' + result.error.message, '确认 dsh 在 PATH 上且版本满足 engines.dsh（>=0.2.1-rc.2 <0.3.0）。')
    return
  }
  const stdout = result.stdout ?? ''
  const hasId = /^- id: dsh-phone$/m.test(stdout)
  const hasName = /^  name: dsh-phone$/m.test(stdout)
  if (result.status === 0 && hasId && hasName) {
    pass('dump-config', 'dsh --dump-config', '已组合出 - id: dsh-phone / name: dsh-phone')
    return
  }
  const detail =
    result.status === 0
      ? '--dump-config 退出 0，但没有 dsh-phone 行（id=' + hasId + ', name=' + hasName + '）'
      : '--dump-config 退出码 ' + result.status + '：' + tail(result.stderr, 3)
  fail(
    'dump-config',
    'dsh --dump-config',
    detail,
    [
      '先确认第 2 项 bundles（缺 bundles 时 dump-config 一定没有插件行）。',
      '若 bundles 已包含：检查 profile 依赖是否装好（dsh plugin --profile ' + profile + ' install）、engines.dsh 是否匹配，然后重启 DSH。',
    ].join('\n'),
  )
}

/* --------------------------------- 4. API --------------------------------- */
async function checkApi() {
  const agent = readAgentToken()
  const baseUrl = values['base-url'] ?? agent?.baseUrl
  const token = values.token ?? agent?.token
  if (!baseUrl) {
    skip(
      'api',
      '运行中 API',
      '未找到 baseUrl（没有运行中的 DSH 或 agent.json 不存在）',
      '启动 dsh web 后重跑；或显式传 --base-url http://127.0.0.1:<port>（token 从 $DSH_HOME/storages/dsh-phone/agent.json 读取）。',
    )
    return
  }
  if (!token) {
    skip(
      'api',
      '运行中 API',
      '缺少本地 Agent token（' + tokenFile + '）',
      '插件加载后会生成该文件；若 DSH 未运行或插件未加载，先解决第 1–3 项。也可用 --token 显式传入。',
    )
    return
  }
  const url = baseUrl.replace(/\/$/, '') + API_PATH
  let response
  try {
    response = await fetch(url, {
      headers: { 'x-dsh-phone-token': token },
      signal: AbortSignal.timeout(5000),
    })
  } catch (error) {
    fail(
      'api',
      '运行中 API',
      '请求 ' + url + ' 失败：' + (error instanceof Error ? error.message : String(error)),
      '确认 dsh web 正在运行且 --base-url 端口正确；重启 DSH 后重试。',
    )
    return
  }
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (response.status === 200 && body && typeof body === 'object') {
    if (body.ok === true) {
      const state = body.value?.state ?? '?'
      pass('api', '运行中 API', 'GET ' + API_PATH + ' → 200 ok=true（state=' + state + '）')
      return
    }
    const code = body.error?.code
    if (typeof code === 'string' && code.startsWith('E_ONBOARDING')) {
      pass('api', '运行中 API', 'GET ' + API_PATH + ' → 200 ' + code + '（路由已注册；首次使用守卫生效）')
      return
    }
    fail('api', '运行中 API', 'GET ' + API_PATH + ' → 200 但响应不是 dsh-phone 成功/onboarding 体：' + tail(text, 1), '确认命中的是 dsh-phone 路由；重启 DSH。')
    return
  }
  if (response.status === 404) {
    fail(
      'api',
      '运行中 API',
      'GET ' + API_PATH + ' → 404（Host 未注册路由：插件行没加载或 enabled=false）',
      '先修复第 2–3 项（bundles / dump-config），重启 DSH；若插件关闭，请用户启用。',
    )
    return
  }
  if (response.status === 401 || response.status === 403) {
    fail(
      'api',
      '运行中 API',
      'GET ' + API_PATH + ' → ' + response.status + '（本地 Agent token 失效：插件重载会轮换 token）',
      '重读 ' + tokenFile + ' 后重试；或重启 DSH 生成新 token。',
    )
    return
  }
  fail('api', '运行中 API', 'GET ' + API_PATH + ' → ' + response.status + '：' + tail(text, 1), '检查 DSH 日志与 docs/troubleshooting.md。')
}

/* -------------------------------- 输出 -------------------------------- */
const label = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }

async function main() {
  if (!existsSync(manifestPath)) {
    console.error('[install-check] 找不到 profile：' + profileDir)
    console.error('  先安装到该 profile：dsh plugin --profile ' + profile + ' add <release-tgz 路径或 git URL>')
    process.exitCode = 2
    return
  }
  const manifest = readJson(manifestPath)
  checkDependency(manifest)
  checkBundles(manifest)
  checkDumpConfig()
  await checkApi()

  const failures = results.filter((item) => item.status === 'fail')
  const skipped = results.filter((item) => item.status === 'skip')

  if (values.json) {
    console.log(JSON.stringify({ profile, profileDir, results, failures: failures.length, skipped: skipped.length }, null, 2))
  } else {
    console.log('[install-check] profile=' + profile + ' dir=' + profileDir)
    for (const item of results) {
      console.log('  [' + label[item.status] + '] ' + item.title + '：' + item.detail.split('\n')[0])
      if (item.status !== 'pass' && item.fix) {
        for (const line of item.fix.split('\n')) console.log('         修复: ' + line)
      }
    }
    console.log(
      '[install-check] 结论：' + (results.length - failures.length - skipped.length) + ' 通过，' + failures.length + ' 失败，' + skipped.length + ' 跳过',
    )
  }

  if (failures.length > 0) process.exitCode = 1
  else if (values['strict-api'] && skipped.some((item) => item.id === 'api')) process.exitCode = 1
}

await main()
