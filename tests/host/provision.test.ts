import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  avdCreateCommand,
  avdListCommand,
  locateSdkTools,
  outputToLogLines,
  parseProgressPercent,
  sdkmanagerInstallCommand,
  sdkmanagerLicensesCommand,
  trimLog,
} from '../../src/provisioning/commands.ts'
import { Provisioner } from '../../src/provisioning/service.ts'
import type { ProvisionDeps, ProvisionRequest } from '../../src/provisioning/types.ts'
import {
  MIN_FREE_DISK_BYTES,
  PROVISION_LOG_LIMIT,
  PROVISION_SYSTEM_IMAGE,
  PROVISION_SYSTEM_IMAGE_ATD,
} from '../../src/provisioning/types.ts'

interface CommandResultLike {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface Call {
  file: string
  args: string[]
  timeoutMs?: number
}

type Handler = (call: Call) => CommandResultLike | undefined

class FakeRunner {
  calls: Call[] = []
  #handlers: Handler[] = []
  on(handler: Handler): this {
    this.#handlers.push(handler)
    return this
  }
  async run(file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<CommandResultLike> {
    const call: Call = { file, args: [...args], timeoutMs: options?.timeoutMs }
    this.calls.push(call)
    for (const handler of [...this.#handlers].reverse()) {
      const result = handler(call)
      if (result !== undefined) return result
    }
    // 默认成功（AVD 列表为空、安装/许可/创建均成功）
    if (args.includes('list') && args.includes('avd')) {
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  count(predicate: (call: Call) => boolean): number {
    return this.calls.filter(predicate).length
  }
}

function ok(overrides: Partial<CommandResultLike> = {}): CommandResultLike {
  return { code: 0, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function makeDeps(overrides: Partial<ProvisionDeps> = {}, runner = new FakeRunner()): {
  deps: ProvisionDeps
  runner: FakeRunner
  clock: { now: number }
} {
  const clock = { now: 1_000_000 }
  const deps: ProvisionDeps = {
    runner,
    platform: async () => 'linux',
    pathExists: async (path) => path.endsWith('sdkmanager'),
    hasCommand: async (command) => command === 'docker',
    findEmulator: async () => '/sdk/emulator/emulator',
    findAvdManager: async () => '/sdk/cmdline-tools/latest/bin/avdmanager',
    freeDiskBytes: async () => 10 * 1024 * 1024 * 1024,
    verifyEndpoint: async () => ({ ok: true, latencyMs: 3, banner: 'Pixel 7' }),
    getAttachEndpoint: () => '',
    now: () => clock.now,
    ...overrides,
  }
  return { deps, runner, clock }
}

async function waitFor(
  provisioner: Provisioner,
  state: 'running' | 'done' | 'failed',
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (provisioner.status().state !== state) {
    if (Date.now() > deadline) {
      throw new Error('等待状态超时，当前: ' + JSON.stringify(provisioner.status()))
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function waitForStep(provisioner: Provisioner, step: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (provisioner.status().step !== step) {
    if (Date.now() > deadline) {
      throw new Error('等待步骤超时，当前: ' + JSON.stringify(provisioner.status()))
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function startAndWait(
  provisioner: Provisioner,
  request: ProvisionRequest,
  state: 'done' | 'failed' = 'done',
): Promise<void> {
  provisioner.start(request)
  return waitFor(provisioner, state)
}

test('GET 状态：初始 idle，字段稳定', () => {
  const { deps } = makeDeps()
  const provisioner = new Provisioner(deps)
  assert.deepEqual(provisioner.status(), {
    state: 'idle',
    step: 'idle',
    percent: 0,
    log: [],
  })
})

test('emulator 成功：sdkmanager → licenses → avdmanager 创建，done+100%+日志', async () => {
  const { deps, runner } = makeDeps()
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator' })
  const status = provisioner.status()
  assert.equal(status.state, 'done')
  assert.equal(status.runtime, 'emulator')
  assert.equal(status.percent, 100)
  assert.equal(status.step, 'done')
  assert.match(status.log.join('\n'), /准备完成/)
  const files = runner.calls.map((call) => call.file)
  assert.equal(files.filter((file) => file.endsWith('sdkmanager')).length, 1)
  const installCall = runner.calls.find((call) => call.args.includes('--install'))!
  assert.deepEqual(installCall.args, [
    '--install',
    'emulator',
    PROVISION_SYSTEM_IMAGE,
  ])
  assert.ok(runner.calls.some((call) => call.args.some((arg) => arg.includes('--licenses'))))
  const createCall = runner.calls.find((call) => call.args.includes('create'))!
  assert.deepEqual(createCall.args, avdCreateCommand(
    { sdkmanager: '/sdk/cmdline-tools/latest/bin/sdkmanager', avdmanager: '/sdk/cmdline-tools/latest/bin/avdmanager' },
    undefined,
  ).args)
})

test('emulator 已装好（AVD 存在）：快速 done，不跑安装/许可/创建', async () => {
  const { deps, runner } = makeDeps()
  runner.on((call) => {
    if (call.args.includes('list') && call.args.includes('avd')) {
      return ok({ stdout: 'dsh-phone-avd\nPixel_7_API_34\n' })
    }
    return undefined
  })
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator' })
  assert.equal(provisioner.status().state, 'done')
  assert.equal(runner.count((call) => call.args.includes('--install')), 0)
  assert.equal(runner.count((call) => call.args.includes('--licenses')), 0)
  assert.equal(runner.count((call) => call.args.includes('create')), 0)
  assert.match(provisioner.status().log.join('\n'), /已存在 AVD/)
})

test('image=aosp_atd：安装命令使用 aosp_atd system image', async () => {
  const { deps, runner } = makeDeps()
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator', image: 'aosp_atd' })
  const installCall = runner.calls.find((call) => call.args.includes('--install'))!
  assert.deepEqual(installCall.args, ['--install', 'emulator', PROVISION_SYSTEM_IMAGE_ATD])
})

test('磁盘不足：<3GB 直接 failed，不执行 sdkmanager 安装', async () => {
  const { deps, runner } = makeDeps({ freeDiskBytes: async () => MIN_FREE_DISK_BYTES - 1 })
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator' }, 'failed')
  const status = provisioner.status()
  assert.equal(status.state, 'failed')
  assert.match(status.error ?? '', /磁盘可用空间不足/)
  assert.equal(runner.count((call) => call.args.includes('--install')), 0)
})

test('无网络（sdkmanager 失败）：failed + error + stderr 日志，可重试成功', async () => {
  const { deps, runner } = makeDeps()
  let offline = true
  runner.on((call) => {
    if (call.args.includes('--install') && offline) {
      return { code: 1, stdout: '', stderr: 'Could not resolve host: dl.google.com', timedOut: false }
    }
    return undefined
  })
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator' }, 'failed')
  const failed = provisioner.status()
  assert.equal(failed.state, 'failed')
  assert.match(failed.error ?? '', /命令失败/)
  assert.match(failed.log.join('\n'), /Could not resolve host/)

  offline = false
  await startAndWait(provisioner, { runtime: 'emulator' })
  assert.equal(provisioner.status().state, 'done')
  assert.equal(provisioner.status().error, undefined)
})

test('许可失败：failed 且错误指向 licenses 命令', async () => {
  const { deps, runner } = makeDeps()
  runner.on((call) => {
    if (call.args.some((arg) => arg.includes('--licenses'))) {
      return { code: 1, stdout: '', stderr: 'license not accepted', timedOut: false }
    }
    return undefined
  })
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator' }, 'failed')
  assert.match(provisioner.status().error ?? '', /licenses/)
  assert.match(provisioner.status().log.join('\n'), /license not accepted/)
})

test('AVD 创建失败：failed', async () => {
  const { deps, runner } = makeDeps()
  runner.on((call) => {
    if (call.args.includes('create')) {
      return { code: 1, stdout: '', stderr: 'Package path is not valid', timedOut: false }
    }
    return undefined
  })
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator' }, 'failed')
  assert.equal(provisioner.status().state, 'failed')
  assert.match(provisioner.status().error ?? '', /命令失败/)
})

test('重复调用：done 后同 runtime 直接返回，不再执行命令', async () => {
  const { deps, runner } = makeDeps()
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator' })
  const callsAfterDone = runner.calls.length
  const status = provisioner.start({ runtime: 'emulator' })
  assert.equal(status.state, 'done')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runner.calls.length, callsAfterDone)
})

test('并发互斥：running 期间第二次 POST 返回当前状态且只执行一次安装', async () => {
  const { deps, runner } = makeDeps()
  let releaseInstall: (() => void) | undefined
  runner.on((call) => {
    if (call.args.includes('--install')) {
      return undefined
    }
    return undefined
  })
  // 用阻塞的安装调用模拟慢速下载
  const originalRun = runner.run.bind(runner)
  runner.run = async (file, args, options) => {
    if (args.includes('--install')) {
      await new Promise<void>((resolve) => {
        releaseInstall = resolve
      })
    }
    return originalRun(file, args, options)
  }
  const provisioner = new Provisioner(deps)
  const first = provisioner.start({ runtime: 'emulator' })
  assert.equal(first.state, 'running')
  const second = provisioner.start({ runtime: 'emulator' })
  assert.equal(second.state, 'running')
  await waitForStep(provisioner, 'install')
  releaseInstall!()
  await waitFor(provisioner, 'done')
  assert.equal(runner.count((call) => call.args.includes('--install')), 1)
})

test('超时：命令消耗完 15 分钟预算后下一阶段 failed 并提示超时', async () => {
  const { deps, runner } = makeDeps()
  const clock = { now: 0 }
  deps.now = () => clock.now
  runner.on((call) => {
    if (call.args.includes('--install')) {
      clock.now += 16 * 60_000
    }
    return undefined
  })
  const provisioner = new Provisioner(deps)
  await startAndWait(provisioner, { runtime: 'emulator' }, 'failed')
  assert.match(provisioner.status().error ?? '', /超时/)
})

test('redroid：缺 docker/binder → failed + 手动命令日志；齐全 → done', async () => {
  const missing = makeDeps({
    pathExists: async () => false,
    hasCommand: async () => false,
  })
  const provisioner = new Provisioner(missing.deps)
  await startAndWait(provisioner, { runtime: 'redroid' }, 'failed')
  assert.match(provisioner.status().error ?? '', /Docker/)
  assert.match(provisioner.status().log.join('\n'), /手动命令: sudo modprobe binder_linux/)

  const ready = makeDeps({
    pathExists: async () => true,
    hasCommand: async () => true,
  })
  const readyProvisioner = new Provisioner(ready.deps)
  await startAndWait(readyProvisioner, { runtime: 'redroid' })
  assert.equal(readyProvisioner.status().state, 'done')
})

test('attach：未配置 endpoint → failed；verify 通过 → done；verify 失败 → failed', async () => {
  const empty = makeDeps()
  const emptyProvisioner = new Provisioner(empty.deps)
  await startAndWait(emptyProvisioner, { runtime: 'attach' }, 'failed')
  assert.match(emptyProvisioner.status().error ?? '', /attach\.endpoint/)

  const okDeps = makeDeps({ getAttachEndpoint: () => '127.0.0.1:5555' })
  const okProvisioner = new Provisioner(okDeps.deps)
  await startAndWait(okProvisioner, { runtime: 'attach' })
  assert.equal(okProvisioner.status().state, 'done')

  const badDeps = makeDeps({
    getAttachEndpoint: () => '127.0.0.1:5555',
    verifyEndpoint: async () => ({ ok: false, latencyMs: 5, error: 'ECONNREFUSED' }),
  })
  const badProvisioner = new Provisioner(badDeps.deps)
  await startAndWait(badProvisioner, { runtime: 'attach' }, 'failed')
  assert.match(badProvisioner.status().error ?? '', /ECONNREFUSED/)
})

test('进度：running 时 step/percent 处于阶段区间内', async () => {
  const { deps, runner } = makeDeps()
  let releaseInstall: (() => void) | undefined
  const originalRun = runner.run.bind(runner)
  runner.run = async (file, args, options) => {
    if (args.includes('--install')) {
      await new Promise<void>((resolve) => {
        releaseInstall = resolve
      })
    }
    return originalRun(file, args, options)
  }
  const provisioner = new Provisioner(deps)
  provisioner.start({ runtime: 'emulator' })
  await waitForStep(provisioner, 'install')
  const status = provisioner.status()
  assert.equal(status.step, 'install')
  assert.ok(status.percent >= 10 && status.percent <= 70, String(status.percent))
  releaseInstall!()
  await waitFor(provisioner, 'done')
})

test('命令构建器与工具函数：固定参数、进度解析、日志截断', () => {
  const tools = { sdkmanager: '/sdk/sdkmanager', avdmanager: '/sdk/avdmanager' }
  assert.deepEqual(sdkmanagerInstallCommand(tools, 'google_apis').args, ['--install', 'emulator', PROVISION_SYSTEM_IMAGE])
  assert.equal(sdkmanagerLicensesCommand(tools, 'linux').file, 'sh')
  assert.equal(sdkmanagerLicensesCommand(tools, 'windows').file, 'cmd.exe')
  assert.deepEqual(avdListCommand(tools).args, ['list', 'avd'])
  assert.ok(avdCreateCommand(tools, 'aosp_atd').args.includes(PROVISION_SYSTEM_IMAGE_ATD))
  assert.equal(parseProgressPercent('Progress: 42%\n10%'), 42)
  assert.equal(parseProgressPercent('no percent'), undefined)
  assert.deepEqual(outputToLogLines('a\n\nb\r\nc', 2), ['b', 'c'])
  assert.equal(trimLog(Array.from({ length: PROVISION_LOG_LIMIT + 10 }, (_, index) => String(index))).length, PROVISION_LOG_LIMIT)
})

test('locateSdkTools：avdmanager 同目录 sdkmanager / PATH 兜底 / 缺失', async () => {
  const found = await locateSdkTools({
    platform: async () => 'linux',
    pathExists: async (path) => path === '/sdk/cmdline-tools/latest/bin/sdkmanager',
    hasCommand: async () => false,
    findAvdManager: async () => '/sdk/cmdline-tools/latest/bin/avdmanager',
  })
  assert.deepEqual(found, {
    sdkmanager: '/sdk/cmdline-tools/latest/bin/sdkmanager',
    avdmanager: '/sdk/cmdline-tools/latest/bin/avdmanager',
  })

  const pathFallback = await locateSdkTools({
    platform: async () => 'linux',
    pathExists: async () => false,
    hasCommand: async (command) => command === 'sdkmanager',
    findAvdManager: async () => '/usr/bin/avdmanager',
  })
  assert.equal(pathFallback?.sdkmanager, 'sdkmanager')

  const missing = await locateSdkTools({
    platform: async () => 'linux',
    pathExists: async () => false,
    hasCommand: async () => false,
    findAvdManager: async () => undefined,
  })
  assert.equal(missing, undefined)
})