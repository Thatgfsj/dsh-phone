#!/usr/bin/env node
/**
 * measure-boot.mjs —— emulator 启动性能可重复测量（issue #67）。
 *
 * 测量项（每个都取多次的中位数/最小值）：
 * 1. cold     ：删除快照后冷启动 → adbd 端口就绪 / sys.boot_completed=1 / 首帧截图
 * 2. snapshot ：优雅退出保存快照后，用 -snapshot default_boot 启动（快照启动）
 * 3. resume   ：暂停恢复（SIGTERM 保存 → 快照加载重启），与 snapshot 同机制、单独计时
 * 4. frame    ：boot_completed 后第一次 screencap 的耗时（面板首帧的代理指标）
 *
 * 安全：只使用 --console-port（默认 5556，必须 >= 5556）与 adb=console+1；
 * 绝不连接/停止 5554/5555 上的用户实例；只向自己 spawn 的进程组发信号。
 *
 * 用法：
 *   node scripts/verify/measure-boot.mjs [--repeat 2] [--json] [--keep-avd]
 *   node scripts/verify/measure-boot.mjs --help
 */
import { spawn, execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const ANDROID_HOME = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Android', 'Sdk')
const EMULATOR = join(ANDROID_HOME, 'emulator', 'emulator')
const AVDMANAGER = join(ANDROID_HOME, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
const AVD_HOME = process.env.ANDROID_AVD_HOME || join(homedir(), '.android', 'avd')
const SNAPSHOT_NAME = 'default_boot'
const DEFAULT_AVD = 'dsh-phone-perf'
const MIN_CONSOLE_PORT = 5556
const CONSOLE_LISTEN_TIMEOUT_MS = 180_000
const BOOT_TIMEOUT_MS = 240_000

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function parseArgs(argv) {
  const options = {
    avd: DEFAULT_AVD,
    consolePort: MIN_CONSOLE_PORT,
    image: '',
    repeat: 1,
    json: false,
    keepAvd: false,
    help: false,
    out: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--keep-avd') options.keepAvd = true
    else if (arg === '--avd') { options.avd = argv[++i]; if (!options.avd) throw new Error('--avd 需要值') }
    else if (arg === '--image') { options.image = argv[++i]; if (!options.image) throw new Error('--image 需要值') }
    else if (arg === '--console-port') { options.consolePort = Number(argv[++i]); if (!Number.isInteger(options.consolePort)) throw new Error('--console-port 需要整数') }
    else if (arg === '--repeat') { options.repeat = Number(argv[++i]); if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat 需要 >=1 的整数') }
    else if (arg === '--out') { options.out = argv[++i]; if (!options.out) throw new Error('--out 需要路径') }
    else throw new Error('未知参数: ' + arg)
  }
  return options
}

function usage() {
  console.log([
    '用法: node scripts/verify/measure-boot.mjs [选项]',
    '',
    '  --avd <name>          测量用 AVD（默认 ' + DEFAULT_AVD + '，不存在则用 avdmanager 创建）',
    '  --console-port <n>    emulator console 端口（>= ' + MIN_CONSOLE_PORT + '，默认 ' + MIN_CONSOLE_PORT + '，adb=port+1）',
    '  --image <pkg>         AVD system image（默认优先 aosp_atd，其次已安装的 android-34 google_apis）',
    '  --repeat <n>          每种场景重复次数（默认 1）',
    '  --json                只输出 JSON（便于脚本消费）',
    '  --out <file>          额外把 JSON 写入文件',
    '  --keep-avd            测量后保留 AVD（默认保留；仅用于显式声明）',
    '',
    '安全：只使用 >= ' + MIN_CONSOLE_PORT + ' 的端口，绝不触碰 5554/5555 的用户实例。',
  ].join('\n'))
}

/**
 * 端口是否有人在监听（connect 探测，不占用端口）。
 * 注意：await 端口就绪必须用它；用 bind 探测会与 emulator 抢端口导致启动失败。
 */
export function assertSafeConsolePort(port) {
  if (!Number.isInteger(port) || port < MIN_CONSOLE_PORT) {
    throw new Error('--console-port 必须 >= ' + MIN_CONSOLE_PORT + '（保护 5554/5555 用户实例）')
  }
  return port
}

export async function isPortListening(port, host = '127.0.0.1', timeoutMs = 300) {
  return await new Promise((done) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      done(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** 端口是否空闲（bind 探测；只用于启动前的占用检查，不在等待就绪时调用）。 */
export async function isPortFree(port, timeoutMs = 400) {
  return await new Promise((done) => {
    const server = createServer()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { server.close() } catch { /* already closed */ }
      done(value)
    }
    const timer = setTimeout(() => finish(true), timeoutMs)
    timer.unref?.()
    server.once('error', () => finish(false))
    server.listen(port, '127.0.0.1', () => finish(true))
  })
}

export async function chooseSystemImage(androidHome, explicit) {
  if (explicit) return explicit
  const base = join(androidHome, 'system-images')
  let versions = []
  try { versions = await readdir(base) } catch { versions = [] }
  const images = []
  for (const version of versions) {
    let tags = []
    try { tags = await readdir(join(base, version)) } catch { continue }
    for (const tag of tags) {
      let abis = []
      try { abis = await readdir(join(base, version, tag)) } catch { continue }
      for (const abi of abis) images.push('system-images;' + version + ';' + tag + ';' + abi)
    }
  }
  const preferred = images.find((image) => image.includes(';aosp_atd;'))
  if (preferred) return preferred
  const googleApis = images.find((image) => image.includes(';google_apis;') && image.endsWith(';x86_64'))
  if (googleApis) return googleApis
  if (images.length > 0) return images[0]
  throw new Error('没有已安装的 system image；请先用 sdkmanager 安装（插件不代装）')
}

function run(file, args, options = {}) {
  return new Promise((done, fail) => {
    execFile(file, args, { timeout: options.timeoutMs || 120_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && options.allowFailure !== true) fail(new Error(file + ' 失败: ' + (stderr || error.message)))
      else if (options.allowFailure !== true && /^(KO|ERROR)/m.test(stderr || '')) fail(new Error(file + ' 失败: ' + stderr))
      else done({ stdout: stdout || '', stderr: stderr || '', code: error ? (error.code || 1) : 0 })
    })
  })
}

async function listAvds() {
  const result = await run(EMULATOR, ['-list-avds'], { allowFailure: true })
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

async function ensureAvd(options) {
  const existing = await listAvds()
  if (existing.includes(options.avd)) return { created: false }
  const image = await chooseSystemImage(ANDROID_HOME, options.image)
  console.log('[measure] 创建独立 AVD ' + options.avd + '（' + image + '）…')
  await run(AVDMANAGER, ['create', 'avd', '-n', options.avd, '-k', image, '-d', 'medium_phone', '--force'], { timeoutMs: 180_000 })
  return { created: true }
}

function avdPaths(avd) {
  return {
    dir: join(AVD_HOME, avd + '.avd'),
    snapshots: join(AVD_HOME, avd + '.avd', 'snapshots'),
    snapshot: join(AVD_HOME, avd + '.avd', 'snapshots', SNAPSHOT_NAME),
  }
}

export async function hasSnapshot(avd) {
  const paths = avdPaths(avd)
  if (!existsSync(paths.snapshot)) return false
  try {
    const entries = await readdir(paths.snapshot)
    return entries.length > 0
  } catch {
    return false
  }
}

export function measureGpuMode() {
  if (process.env.DSH_MEASURE_GPU) return process.env.DSH_MEASURE_GPU
  return existsSync('/dev/dri') ? 'angle_indirect' : 'swiftshader_indirect'
}

export function emulatorArgs(avd, consolePort, mode) {
  const gpu = measureGpuMode()
  const args = [
    '-avd', avd,
    '-no-window',
    '-no-audio',
    '-no-boot-anim',
    '-gpu', gpu,
    '-netdelay', 'none',
    '-netspeed', 'full',
    '-no-metrics',
    '-camera-back', 'none',
    '-camera-front', 'none',
    '-memory', process.env.DSH_MEASURE_MEMORY_MB || '2048',
    '-cores', process.env.DSH_MEASURE_CORES || '4',
    '-port', String(consolePort),
  ]
  if (process.env.DSH_MEASURE_SKIN) args.push('-skin', process.env.DSH_MEASURE_SKIN)
  if (mode === 'cold') {
    args.push('-no-snapshot-load', '-snapshot', SNAPSHOT_NAME)
  } else {
    args.push('-snapshot', SNAPSHOT_NAME)
  }
  return args
}

export async function startEmulator(options, mode) {
  const args = emulatorArgs(options.avd, options.consolePort, mode)
  const logPath = '/tmp/dsh-phone-measure-emulator-' + options.consolePort + '.log'
  const fd = openSync(logPath, 'a')
  const child = spawn(EMULATOR, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ANDROID_HOME },
  })
  closeSync(fd)
  let exitCode
  child.once('exit', (code) => {
    exitCode = code ?? -1
  })
  child.unref()
  return {
    pid: child.pid,
    startedAt: Date.now(),
    args: args,
    logPath: logPath,
    exitCode: () => exitCode,
    logTail: () => {
      try {
        return readFileSync(logPath, 'utf8').split('\n').slice(-20).join('\n')
      } catch {
        return ''
      }
    },
  }
}

/**
 * 通过 emulator console 主动保存 quick-boot 快照（比依赖 SIGTERM 退出保存更可靠）。
 * 失败返回 false，调用方继续正常停止（不阻断测量）。
 */
export async function saveSnapshotViaConsole(options) {
  const consolePort = options.consolePort
  let authToken
  const tokenPath = join(osHomedir(), '.emulator_console_auth_token')
  try { authToken = readFileSync(tokenPath, 'utf8').trim() } catch { authToken = undefined }
  try {
    const module = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'emulator-console.ts')).href)
    const result = await module.runEmulatorConsoleCommand({
      port: consolePort,
      command: 'avd snapshot save ' + SNAPSHOT_NAME,
      authToken,
      timeoutMs: 120_000,
    })
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 优雅停止：先给 launcher（child.pid）SIGTERM 让它有机会保存快照，
 * 等它退出；超时再对整个进程组降级 SIGTERM/SIGKILL。
 */
async function stopEmulator(pid) {
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      // launcher 已退出（快照保存完成）；稍等子进程收尾
      await sleep(500)
      return
    }
    await sleep(250)
  }
  await killGroup(pid, 'SIGTERM')
  const grace = Date.now() + 20_000
  while (Date.now() < grace) {
    if (!isProcessGroupAlive(pid) && !isPidAlive(pid)) return
    await sleep(250)
  }
  await killGroup(pid, 'SIGKILL')
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function killGroup(pid, signal) {
  try { process.kill(-pid, signal) } catch {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

function isProcessGroupAlive(pid) {
  try { process.kill(-pid, 0); return true } catch {
    try { process.kill(pid, 0); return true } catch { return false }
  }
}

async function waitPort(port, timeoutMs, started) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true
    const exitCode = started && started.exitCode && started.exitCode()
    if (exitCode !== undefined) {
      throw new Error(
        'emulator 提前退出（exit=' + exitCode + '）\n' + (started.logTail ? started.logTail() : '')
      )
    }
    await sleep(200)
  }
  return false
}

async function connectAdb(adbPort, timeoutMs) {
  const module = await import(pathToFileURL(join(ROOT, 'src', 'adb', 'transport.ts')).href)
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const connection = await module.connect({ host: '127.0.0.1', port: adbPort }, { timeoutMs: 2_000 })
      return { connection, module }
    } catch (error) {
      lastError = error
      await sleep(400)
    }
  }
  throw new Error('ADB 连接失败: ' + (lastError instanceof Error ? lastError.message : String(lastError)))
}

async function waitBootCompleted(connection, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let shellReady = 0
  while (Date.now() < deadline) {
    let value = ''
    try { value = (await connection.shell('getprop sys.boot_completed')).trim() } catch { value = '' }
    if (value === '1') {
      try {
        const pm = await connection.shell('pm path android')
        if (pm.includes('package:')) return true
      } catch { /* package manager not ready yet */ }
      shellReady += 1
    }
    await sleep(200)
  }
  throw new Error('boot_completed 等待超时（' + timeoutMs + 'ms, shellReady=' + shellReady + '）')
}

async function firstFrame(connection, timeoutMs = 60_000) {
  const module = await import(pathToFileURL(join(ROOT, 'src', 'adb', 'device.ts')).href)
  const device = new module.AdbDevice(connection)
  const started = Date.now()
  let attempts = 0
  let lastError
  while (Date.now() - started < timeoutMs) {
    attempts += 1
    try {
      await device.screenshot({ attempts: 1, sleep })
      return { ms: Date.now() - started, attempts }
    } catch (error) {
      lastError = error
      await sleep(500)
    }
  }
  throw new Error('首帧截图超时（' + attempts + ' 次）: ' + (lastError instanceof Error ? lastError.message : String(lastError)))
}

async function measureOnce(options, mode) {
  const adbPort = options.consolePort + 1
  const started = await startEmulator(options, mode)
  const result = { mode, startedAt: new Date().toISOString() }
  try {
    const portReadyAt = await waitPort(adbPort, CONSOLE_LISTEN_TIMEOUT_MS, started)
    if (!portReadyAt) throw new Error('adbd 端口未就绪（' + adbPort + '）')
    result.portMs = Date.now() - started.startedAt
    const { connection } = await connectAdb(adbPort, BOOT_TIMEOUT_MS)
    try {
      result.adbMs = Date.now() - started.startedAt
      await waitBootCompleted(connection, BOOT_TIMEOUT_MS)
      result.bootMs = Date.now() - started.startedAt
      const frame = await firstFrame(connection)
      result.frameMs = frame.ms
      result.frameAttempts = frame.attempts
      result.frameAtMs = Date.now() - started.startedAt
    } finally {
      await connection.close().catch(() => {})
    }
    result.ok = true
  } catch (error) {
    result.ok = false
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    // 先 console 主动保存快照，再优雅停止（SIGTERM 退出保存为兜底）
    const saveStarted = Date.now()
    result.snapshotSave = await saveSnapshotViaConsole(options)
    result.snapshotSaveMs = Date.now() - saveStarted
    await stopEmulator(started.pid)
    result.totalMs = Date.now() - started.startedAt
  }
  return result
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

function summarize(results) {
  const byMode = {}
  for (const result of results) {
    if (!result.ok) continue
    const bucket = (byMode[result.mode] ||= { portMs: [], adbMs: [], bootMs: [], frameMs: [] })
    bucket.portMs.push(result.portMs)
    bucket.adbMs.push(result.adbMs)
    bucket.bootMs.push(result.bootMs)
    bucket.frameMs.push(result.frameMs)
  }
  const summary = {}
  for (const [mode, bucket] of Object.entries(byMode)) {
    summary[mode] = {
      samples: bucket.bootMs.length,
      portMs: median(bucket.portMs),
      adbMs: median(bucket.adbMs),
      bootMs: median(bucket.bootMs),
      frameMs: median(bucket.frameMs),
    }
  }
  return summary
}

function formatMarkdown(summary, environment) {
  const lines = []
  lines.push('| 场景 | 样本 | adbd 端口就绪 | boot_completed | 首帧截图 |')
  lines.push('|---|---|---|---|---|')
  const labels = { cold: '冷启动（无快照）', snapshot: '快照启动', resume: '暂停恢复（快照加载）' }
  for (const [mode, value] of Object.entries(summary)) {
    lines.push('| ' + (labels[mode] || mode) + ' | ' + value.samples + ' | ' + value.portMs + 'ms | ' + value.bootMs + 'ms | ' + value.frameMs + 'ms |')
  }
  lines.push('')
  lines.push('环境：' + environment)
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { usage(); return }
  assertSafeConsolePort(options.consolePort)
  const adbPort = options.consolePort + 1
  if (!(await isPortFree(options.consolePort))) throw new Error('console 端口 ' + options.consolePort + ' 已被占用，换一个')
  if (!(await isPortFree(adbPort))) throw new Error('adb 端口 ' + adbPort + ' 已被占用，换一个')
  if (!existsSync(EMULATOR)) throw new Error('找不到 emulator: ' + EMULATOR)

  const avdInfo = await ensureAvd(options)

  const image = avdInfo.created ? await chooseSystemImage(ANDROID_HOME, options.image) : ''
  const environment = [
    'emulator=' + (await run(EMULATOR, ['-version'], { allowFailure: true })).stdout.split('\n')[0].trim(),
    'avd=' + options.avd,
    'image=' + (image || '已有 AVD'),
    'console=' + options.consolePort + ' adb=' + adbPort,
    'cores=' + (process.env.DSH_MEASURE_CORES || '4') + ' memoryMb=' + (process.env.DSH_MEASURE_MEMORY_MB || '2048'),
    'hostCpu=' + (await run('nproc', [], { allowFailure: true })).stdout.trim(),
    'host=' + process.platform,
  ].join('; ')

  console.log('[measure] ' + environment)
  const results = []
  for (let round = 0; round < options.repeat; round += 1) {
    console.log('[measure] round ' + (round + 1) + '/' + options.repeat)
    // 1) 冷启动：先删快照
    await rm(avdPaths(options.avd).snapshots, { recursive: true, force: true })
    results.push(await measureOnce(options, 'cold'))
    // 2) 快照启动（cold 优雅退出时应已保存快照）
    if (await hasSnapshot(options.avd)) {
      results.push(await measureOnce(options, 'snapshot'))
      // 3) 暂停恢复：等价于再次 SIGTERM 后从快照启动
      results.push(await measureOnce(options, 'resume'))
    } else {
      console.warn('[measure] 冷启动后没有生成快照，跳过 snapshot/resume 测量')
    }
  }
  if (!options.keepAvd) {
    console.log('[measure] 保留测量 AVD（--keep-avd 语义；如需清理请手动 avdmanager delete avd -n ' + options.avd + '）')
  }

  const summary = summarize(results)
  const report = { environment, options: { ...options }, results, summary }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('')
    console.log(formatMarkdown(summary, environment))
    console.log('')
    console.log(JSON.stringify(report.results.map((r) => ({ mode: r.mode, ok: r.ok, error: r.error })), null, 2))
  }
  if (options.out) {
    await mkdir(dirname(resolve(options.out)), { recursive: true })
    await writeFile(resolve(options.out), JSON.stringify(report, null, 2) + '\n')
    console.log('[measure] JSON 写入 ' + resolve(options.out))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[measure] 失败: ' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
