#!/usr/bin/env node
/**
 * verify-install：临时 profile 安装冒烟（不碰用户 web/headless profile）。
 *
 * 阶段 A（默认 DSH_HOME 下的临时 profile `phone-verify`，headless 模板）：
 * 1. 构建插件（lib/ 不在版本库，必须先 build）；
 * 2. `dsh --profile phone-verify --from-default-profile headless --dump-config` 初始化（自定义 profile 默认只有 dsh-base，没有 app，直接 --help 会挂起）；
 * 3. `dsh plugin --profile phone-verify add .` 安装本地包；
 * 4. 断言 profile manifest、安装产物（lib/index.js、lib/client.js 包装、locale、icon、exports）；
 * 5. `--dump-config` 必须出现 `id: dsh-phone` 行；写入临时用户层后 config 值必须在 dump 中生效；
 * 6. `--dump-config-schema` 必须含 attach.userHint/endpoint/resolved（volatile）、stream、lifecycle 等；
 * 7. `--help` 真执行 apply（stderr 不得有插件加载错误）。
 *
 * 阶段 B（隔离临时 DSH_HOME，web 模板）：证明 apply 真执行且有可观察效果：
 * 8. 起 web（--no-open --port 0），捕获启动 URL；agent.json token 0600 落盘；
 * 9. 未认证 GET /dsh-phone/api/config → 401 E_AUTH；
 * 10. 带启动 URL 的浏览器 token → 200，且 profile 用户层配置生效（runtime=attach / maxSize=640）。
 *
 * finally 无条件删除两个临时 profile/临时 DSH_HOME、停止子进程；不读写用户 ~/.dsh 的 web/headless profile。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  REPO_ROOT,
  Cleanup,
  assert,
  assertDeepEqual,
  assertEqual,
  assertIncludes,
  assertMatch,
  evidence,
  expectSuccess,
  run,
  runScript,
  spawnManaged,
  step,
} from './shared/harness.mjs'
import { assertSchema } from './shared/config-schema.mjs'

const PROFILE = 'phone-verify'
const SHIPPED_PROFILES = new Set(['web', 'headless', 'tui', 'acp', 'sdk', 'sdk-minimal', 'desktop'])

const cleanup = new Cleanup()
/** 默认 DSH_HOME（可用环境变量覆盖，测试隔离场景用临时目录）。 */
const defaultHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
let webProcess

function profileDir(home) {
  return join(home, 'profiles', PROFILE)
}

function dshEnv(home) {
  return { ...process.env, DSH_HOME: home }
}

function dsh(args, options = {}) {
  return run('dsh', args, { ...options, cwd: REPO_ROOT })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 只删除我们自己的临时 profile；已存在但没有 verify 标记时拒绝动它。 */
function removeStaleProfile(dir) {
  if (!existsSync(dir)) return
  let name
  try {
    name = readJson(join(dir, 'package.json')).name
  } catch {
    name = undefined
  }
  if (name !== 'dsh-profile-' + PROFILE) {
    throw new Error('临时 profile 路径已存在且不像 verify 创建（package.name=' + name + '），拒绝删除: ' + dir)
  }
  rmSync(dir, { recursive: true, force: true })
  console.log('[verify] 清理上次残留的临时 profile: ' + dir)
}

/** 用户层补丁：只存在于临时 profile，用于断言 config 真正生效。 */
function writeUserLayer(dir) {
  const patchFile = join(dir, 'cordis.patch.yml')
  // initProfile 写入的模板是注释 + 空列表 `[]`；追加条目必须先移除空列表，
  // 否则 YAML 出现两个顶层节点（parsePatchList 直接报错）。
  const kept = readFileSync(patchFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '[]')
    .join('\n')
    .trimEnd()
  const patch = [
    kept,
    '',
    '# verify-install 临时用户层（仅存在于临时 profile，随 profile 一起删除）',
    '- id: dsh-phone',
    '  config:',
    '    runtime: attach',
    '    attach:',
    '      userHint: 验证用一句话',
    '    stream:',
    '      maxSize: 640',
    '      maxFps: 15',
    '      bitrate: 2000000',
    '',
  ].join('\n')
  writeFileSync(patchFile, patch)
}

/** 依赖/构建：干净 checkout 首次运行时自动 npm install（仅此一种联网可能）。 */
async function ensureDependenciesAndBuild() {
  const nodeModules = join(REPO_ROOT, 'node_modules')
  if (!existsSync(nodeModules) || !existsSync(join(nodeModules, 'esbuild'))) {
    console.log('[verify] node_modules 缺失，执行 npm install --no-audit --no-fund …')
    expectSuccess(await run('npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 600_000 }), 'npm install')
  }
  const build = expectSuccess(await run('npm', ['run', 'build'], { timeoutMs: 180_000 }), 'npm run build')
  assertIncludes(build.stdout, 'done:', 'build 必须输出 done')
  assert(existsSync(join(REPO_ROOT, 'lib', 'index.js')), 'build 后缺少 lib/index.js')
  assert(existsSync(join(REPO_ROOT, 'lib', 'client.js')), 'build 后缺少 lib/client.js')
  evidence('build', build.stdout.trim().split('\n').at(-1))
}

function assertInstalledMetadata(dir) {
  const installed = join(dir, 'node_modules', 'dsh-phone')
  assert(existsSync(installed), 'profile node_modules 中找不到 dsh-phone: ' + installed)
  const pkg = readJson(join(installed, 'package.json'))
  assertEqual(pkg.name, 'dsh-phone', '安装包 name')
  for (const key of ['.', './client', './package.json', './locale/*.json', './icon']) {
    assert(pkg.exports?.[key] !== undefined, 'package.json exports 缺少 ' + key)
  }
  assert(existsSync(join(installed, 'lib', 'index.js')), '安装产物缺少 lib/index.js')
  const client = readFileSync(join(installed, 'lib', 'client.js'), 'utf8')
  assertIncludes(client, 'window.__ModuleLoader__.load(', 'lib/client.js 必须包装 __ModuleLoader__.load')
  assertIncludes(client, 'dsh-phone', 'lib/client.js 必须声明插件 id')
  for (const locale of ['zh.json', 'en.json']) {
    const file = join(installed, 'locale', locale)
    assert(existsSync(file), '缺少 locale/' + locale)
    const meta = readJson(file).meta
    assert(meta && typeof meta.title === 'string' && meta.title.length > 0, locale + ' 缺少 meta.title')
    assert(typeof meta.description === 'string' && meta.description.length > 0, locale + ' 缺少 meta.description')
  }
  assert(existsSync(join(installed, 'icon.svg')), '缺少 icon.svg')
  evidence('installed metadata', 'exports/.client/locale(zh,en)/icon 均存在，name=' + pkg.name)
}


function assertNoPluginLoadErrors(stderr, label) {
  const lines = String(stderr).split('\n').filter((line) => line.trim().length > 0)
  const pluginErrors = lines.filter(
    (line) => /dsh-phone/i.test(line) && /(error|fail|cannot|无法|失败)/i.test(line),
  )
  assertEqual(pluginErrors.length, 0, label + ' stderr 出现 dsh-phone 插件错误:\n' + pluginErrors.join('\n'))
  assert(!/UnhandledPromiseRejection|ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(stderr), label + ' stderr 存在模块/未处理异常')
  return lines
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 5000) })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { response, body, text }
}

await runScript(async () => {
  assert(!SHIPPED_PROFILES.has(PROFILE), '临时 profile 名不得与 dsh 内置 profile 冲突')
  await step('前置条件与构建（dsh / pnpm / npm run build）', async () => {
    const dshVersion = expectSuccess(await dsh(['--version'], { timeoutMs: 60_000 }), 'dsh --version')
    const pnpmVersion = expectSuccess(await run('pnpm', ['--version'], { timeoutMs: 60_000 }), 'pnpm --version')
    evidence('toolchain', 'dsh ' + dshVersion.stdout.trim() + ', pnpm ' + pnpmVersion.stdout.trim() + ', node ' + process.version)
    await ensureDependenciesAndBuild()
  })

  /* ------------------------------- 阶段 A：安装冒烟 ------------------------------- */
  const home = defaultHome
  const dir = profileDir(home)
  removeStaleProfile(dir)
  cleanup.register('删除临时 profile ' + dir, () => rmSync(dir, { recursive: true, force: true }))

  await step('安装：--from-default-profile headless 初始化 + dsh plugin add .', async () => {
    const seed = expectSuccess(
      await dsh(['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], {
        env: dshEnv(home),
        timeoutMs: 120_000,
      }),
      '初始化临时 profile',
    )
    assertIncludes(seed.stdout, '- id:', '初始化后的 dump-config 应包含已组合的条目')
    const add = expectSuccess(
      await dsh(['plugin', '--profile', PROFILE, 'add', '.'], { env: dshEnv(home), timeoutMs: 300_000 }),
      'dsh plugin add',
    )
    evidence('plugin add', (add.stdout || add.stderr).trim().split('\n').filter(Boolean).at(-1) ?? 'exit 0')

    const manifest = readJson(join(dir, 'package.json'))
    assert(manifest.dependencies?.['dsh-phone'] !== undefined, 'profile manifest 缺少 dsh-phone 依赖')
    assert(manifest.dsh?.profile?.bundles?.includes('dsh-phone') === true, 'profile bundles 必须包含 dsh-phone')
    assertInstalledMetadata(dir)
  })

  await step('dump-config：dsh-phone 行存在，用户层 config 生效', async () => {
    const before = expectSuccess(
      await dsh(['--profile', PROFILE, '--dump-config'], { env: dshEnv(home), timeoutMs: 120_000 }),
      'dump-config（安装后）',
    ).stdout
    assertIncludes(before, '- id: dsh-phone', 'dump-config 必须出现 id: dsh-phone')
    assertIncludes(before, 'name: dsh-phone', 'dump-config 必须出现 name: dsh-phone')
    writeUserLayer(dir)
    const after = expectSuccess(
      await dsh(['--profile', PROFILE, '--dump-config'], { env: dshEnv(home), timeoutMs: 120_000 }),
      'dump-config（写用户层后）',
    ).stdout
    for (const needle of ['runtime: attach', 'maxSize: 640', 'userHint: 验证用一句话']) {
      assertIncludes(after, needle, '用户层 config 未在 dump-config 生效: ' + needle)
    }
    const phoneLines = after.split('\n').filter((line, index, lines) => /id: dsh-phone/.test(line) || /name: dsh-phone/.test(line))
    evidence('dump-config', phoneLines.join(' | '))
    evidence('config 生效', 'runtime: attach / stream.maxSize: 640 / attach.userHint 出现在组合后的 profile 中')
  })

  await step('dump-config-schema：attach.userHint 等字段与 volatile 标记', async () => {
    const result = expectSuccess(
      await dsh(['--profile', PROFILE, '--dump-config-schema'], { env: dshEnv(home), timeoutMs: 180_000 }),
      'dump-config-schema',
    )
    assertSchema(JSON.parse(result.stdout))
  })

  await step('--help：apply 真执行且无插件加载错误', async () => {
    const result = expectSuccess(
      await dsh(['--profile', PROFILE, '--help'], { env: dshEnv(home), timeoutMs: 180_000 }),
      '--help（apply 冒烟）',
    )
    assertIncludes(result.stdout, 'Usage: dsh --profile headless', 'headless app 必须打印自己的 help（说明 profile 成功启动）')
    const lines = assertNoPluginLoadErrors(result.stderr, '--help')
    evidence('--help stderr', lines.join(' | ') || '(empty)')
  })

  /* --------------------- 阶段 B：隔离 DSH_HOME 的 web apply 冒烟 --------------------- */
  await step('隔离 DSH_HOME：web profile 启动 + 路由鉴权 + config 生效', async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-phone-verify-'))
    cleanup.register('删除隔离 DSH_HOME ' + isolatedHome, () => rmSync(isolatedHome, { recursive: true, force: true }))
    const env = dshEnv(isolatedHome)
    const isolatedDir = profileDir(isolatedHome)

    expectSuccess(
      await dsh(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { env, timeoutMs: 120_000 }),
      '初始化隔离 web profile',
    )
    expectSuccess(await dsh(['plugin', '--profile', PROFILE, 'add', '.'], { env, timeoutMs: 300_000 }), '隔离 profile 安装')
    writeUserLayer(isolatedDir)

    webProcess = spawnManaged('dsh', ['--profile', PROFILE, '--no-open', '--port', '0'], { env })
    cleanup.register('停止临时 web 进程', async () => {
      if (webProcess) await webProcess.stop({ timeoutMs: 10_000 })
    })
    const match = await webProcess.waitFor(/dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/, 90_000)
    const origin = 'http://127.0.0.1:' + match[2]
    const browserToken = match[3]
    assert(origin !== 'http://127.0.0.1:3080', 'verify 不得复用用户正在使用的 3080 端口')

    const tokenFile = join(isolatedHome, 'storages', 'dsh-phone', 'agent.json')
    assert(existsSync(tokenFile), 'apply 后应生成 agent.json（本地 Agent 通道凭据）')
    const agent = readJson(tokenFile)
    assertEqual(agent.baseUrl, origin, 'agent.json.baseUrl 必须等于实际监听 origin')
    assertMatch(agent.token, /^[0-9a-f]{64}$/, 'agent.json.token 必须是 64 位十六进制')
    assertEqual(statSync(tokenFile).mode & 0o777, 0o600, 'agent.json 权限必须是 0600')

    const unauthenticated = await fetchJson(origin + '/dsh-phone/api/config')
    assertEqual(unauthenticated.response.status, 401, '未认证 GET /config 必须 401')
    assertEqual(unauthenticated.body?.error?.code, 'E_AUTH', '未认证错误码必须是 E_AUTH')

    const login = await fetch(origin + '/?token=' + browserToken, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    assertEqual(login.status, 303, '启动 URL 的浏览器 token 应 303 下发同源 cookie')
    const setCookies = login.headers.getSetCookie?.() ?? []
    const cookie = setCookies
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith('dsh-auth-'))
    assert(cookie !== undefined, '浏览器 token 未下发 dsh-auth-* cookie')

    const authed = await fetchJson(origin + '/dsh-phone/api/config', { headers: { cookie } })
    assertEqual(authed.response.status, 200, '带同源 cookie 的 GET /config 必须 200')
    assertEqual(authed.body?.ok, true, 'config 响应 ok=true')
    assertEqual(authed.body.value.runtime, 'attach', 'profile 用户层 runtime 必须生效')
    assertEqual(authed.body.value.stream.maxSize, 640, 'profile 用户层 stream.maxSize 必须生效')
    assertEqual(authed.body.value.stream.maxFps, 15, 'stream.maxFps 默认/配置值')
    assertEqual(authed.body.value.stream.bitrate, 2000000, 'stream.bitrate 默认/配置值')
    evidence('web apply', 'origin=' + origin + '，未认证 401 E_AUTH，带 token 200 config(runtime=attach,maxSize=640)')

    const exit = await webProcess.stop()
    evidence('web 进程退出', JSON.stringify(exit))
    const tokenLeft = existsSync(tokenFile)
    console.log('[observe] SIGTERM 后 agent.json ' + (tokenLeft ? '仍存在（异步 dispose 未等待；仅隔离临时 home，不影响用户）' : '已删除'))
  })
}, cleanup)
