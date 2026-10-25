import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_EMULATOR_CORES,
  DEFAULT_EMULATOR_MEMORY_MB,
  EMULATOR_SNAPSHOT_NAME,
  EmulatorRuntime,
} from '../../src/runtime/emulator.ts'
import type { BootPhase, EmulatorOptions } from '../../src/runtime/types.ts'
import { FakeCommandRunner, FakeEnvironment } from '../fake-adb/runtime.ts'

const EMULATOR: EmulatorOptions = { avdName: 'dsh-phone-avd', resolution: '720x1280' }

function makeEnv(overrides: Partial<FakeEnvironment> = {}): FakeEnvironment {
  const env = new FakeEnvironment()
  env.emulatorPath = '/fake/sdk/emulator/emulator'
  env.openPorts.add(5555)
  Object.assign(env, overrides)
  return env
}

function makeAdapter(options: {
  env?: FakeEnvironment
  runner?: FakeCommandRunner
  emulator?: EmulatorOptions
  consoleCommand?: (command: string, authToken?: string) => Promise<{ ok: boolean; output: string; error?: string }>
}) {
  return new EmulatorRuntime({
    emulator: options.emulator ?? EMULATOR,
    deps: { env: options.env ?? makeEnv(), runner: options.runner ?? new FakeCommandRunner() },
    adoptRunning: false,
    consoleCommand: options.consoleCommand,
  })
}

describe('emulator quick-boot 启动参数（issue #67）', () => {
  test('调优 flag：-memory/-cores/-no-metrics/-camera none，并始终带 -snapshot default_boot', async () => {
    const runner = new FakeCommandRunner()
    const adapter = makeAdapter({ env: makeEnv(), runner })
    await adapter.ensureRunning()
    const args = runner.spawns[0]!.args
    assert.ok(args.includes('-no-boot-anim'))
    assert.ok(args.includes('-no-audio') && args.includes('-no-window'))
    assert.ok(args.includes('-gpu') && args.includes('swiftshader_indirect'))
    assert.equal(args[args.indexOf('-memory') + 1], String(DEFAULT_EMULATOR_MEMORY_MB))
    assert.equal(args[args.indexOf('-cores') + 1], String(DEFAULT_EMULATOR_CORES))
    assert.ok(args.includes('-no-metrics'))
    assert.equal(args[args.indexOf('-camera-back') + 1], 'none')
    assert.equal(args[args.indexOf('-camera-front') + 1], 'none')
    // quick-boot：始终选择 default_boot 快照；绝不关闭保存/加载
    assert.equal(args[args.indexOf('-snapshot') + 1], EMULATOR_SNAPSHOT_NAME)
    assert.equal(args.includes('-no-snapshot-save'), false)
    assert.equal(args.includes('-no-snapshot-load'), false)
  })

  test('已有快照 → 启动提示走快照，且不主动再次保存', async () => {
    const runner = new FakeCommandRunner()
    const env = makeEnv({ hasSnapshot: true })
    const consoleCalls: string[] = []
    const adapter = makeAdapter({
      env,
      runner,
      consoleCommand: async (command) => {
        consoleCalls.push(command)
        return { ok: true, output: 'OK' }
      },
    })
    const phases: BootPhase[] = []
    await adapter.ensureRunning((message, phase) => {
      if (phase) phases.push(phase)
      assert.equal(typeof message, 'string')
    })
    assert.deepEqual(consoleCalls, [])
    assert.ok(phases.includes('waiting-adbd'))
    assert.equal(phases.at(-1), 'ready')
  })

  test('首次冷启动成功后主动保存一次快照（console + auth token）', async () => {
    const runner = new FakeCommandRunner()
    const env = makeEnv({ hasSnapshot: false, consoleToken: 'tok-123' })
    const calls: { command: string; token?: string }[] = []
    const adapter = makeAdapter({
      env,
      runner,
      consoleCommand: async (command, token) => {
        calls.push({ command, token })
        // 模拟 console 保存后 snapshot.pb 稳定可读
        env.hasSnapshot = true
        env.snapshotValid = true
        return { ok: true, output: 'OK' }
      },
    })
    const phases: BootPhase[] = []
    await adapter.ensureRunning((_message, phase) => {
      if (phase) phases.push(phase)
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, 'avd snapshot save ' + EMULATOR_SNAPSHOT_NAME)
    assert.equal(calls[0]!.token, 'tok-123')
    assert.ok(phases.includes('saving-snapshot'))
    assert.equal(phases.at(-1), 'ready')
    const status = await adapter.status()
    assert.equal(status.running, true)
  })

  test('快照保存失败不阻断启动；pause 会再尝试一次', async () => {
    const runner = new FakeCommandRunner()
    const env = makeEnv({ hasSnapshot: false })
    const calls: string[] = []
    const adapter = makeAdapter({
      env,
      runner,
      consoleCommand: async (command) => {
        calls.push(command)
        return { ok: false, output: 'KO: snapshot busy', error: 'snapshot busy' }
      },
    })
    await adapter.ensureRunning()
    assert.equal(calls.length, 1)
    await adapter.pause()
    assert.equal(calls.length, 2)
    assert.equal(runner.kills[0]?.signal, 'SIGTERM')
  })

  test('快照已保存后 pause 不再重复 console 保存', async () => {
    const runner = new FakeCommandRunner()
    const env = makeEnv({ hasSnapshot: false })
    const calls: string[] = []
    const adapter = makeAdapter({
      env,
      runner,
      consoleCommand: async (command) => {
        calls.push(command)
        env.hasSnapshot = true
        env.snapshotValid = true
        return { ok: true, output: 'OK' }
      },
    })
    await adapter.ensureRunning()
    await adapter.pause()
    assert.equal(calls.length, 1)
  })

  test('console 抛异常也不阻断启动（best-effort）', async () => {
    const runner = new FakeCommandRunner()
    const env = makeEnv({ hasSnapshot: false })
    const adapter = makeAdapter({
      env,
      runner,
      consoleCommand: async () => {
        throw new Error('boom')
      },
    })
    await adapter.ensureRunning()
    assert.equal((await adapter.status()).running, true)
  })
})


describe('issue #67：adopt 同 AVD / 损坏快照 / FATAL 日志 / skin / cancelStart', () => {
  test('同 AVD 已在运行且端口可达 → adopt 复用，不再 spawn', async () => {
    const runner = new FakeCommandRunner()
    runner.on('ps', () => ({
      code: 0,
      stdout:
        ' 4242 /opt/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless -avd dsh-phone-avd -port 5554 -no-window\n',
      stderr: '',
      timedOut: false,
    }))
    const env = makeEnv()
    env.openPorts.add(5555)
    const adapter = new EmulatorRuntime({ emulator: EMULATOR, deps: { env, runner } })
    const endpoint = await adapter.ensureRunning()
    assert.deepEqual(endpoint, { host: '127.0.0.1', port: 5555 })
    assert.equal(runner.spawns.length, 0)
    assert.equal(adapter.adopted, true)
    const status = await adapter.status()
    assert.equal(status.pid, 4242)
    await adapter.pause()
    assert.equal(runner.kills.length, 0, 'adopt 的用户实例不能被 pause 杀掉')
  })

  test('同 AVD 进程存在但端口不可达 → 明确报错（不再 spawn 第二实例）', async () => {
    const runner = new FakeCommandRunner()
    runner.on('ps', () => ({
      code: 0,
      stdout: ' 4242 /opt/qemu-system-x86_64-headless -avd dsh-phone-avd -port 5554\n',
      stderr: '',
      timedOut: false,
    }))
    const env = makeEnv()
    env.openPorts.clear()
    const adapter = new EmulatorRuntime({ emulator: EMULATOR, deps: { env, runner } })
    await assert.rejects(adapter.ensureRunning(), /已有进程在启动\/运行中/)
    assert.equal(runner.spawns.length, 0)
  })

  test('损坏快照（snapshot.pb 被截断）→ 删除并回退冷启动', async () => {
    const env = makeEnv({ hasSnapshot: true, snapshotValid: false })
    const adapter = makeAdapter({ env, runner: new FakeCommandRunner() })
    const messages: string[] = []
    await adapter.ensureRunning((message) => messages.push(message))
    assert.equal(env.removedSnapshots, 1)
    assert.ok(messages.some((message) => message.includes('损坏的 quick-boot 快照')))
  })

  test('emulator 早退（FATAL）→ 立即失败并把日志尾部带给用户', async () => {
    const runner = new FakeCommandRunner()
    runner.diesAfterSpawn = true
    const env = makeEnv({ fileTail: 'FATAL   | Failed to load snapshot default_boot' })
    env.openPorts.clear()
    const adapter = makeAdapter({ env, runner, emulator: { ...EMULATOR, bootTimeoutMs: 2_000 } })
    await assert.rejects(adapter.ensureRunning(), (error: unknown) => {
      assert.match((error as Error).message, /日志/)
      assert.match((error as Error).message, /Failed to load snapshot/)
      return true
    })
  })

  test('显式 resolution 才传 -skin（默认 720x1280 不覆盖 AVD）', async () => {
    const runner = new FakeCommandRunner()
    const adapter = makeAdapter({ env: makeEnv(), runner, emulator: { ...EMULATOR, resolution: '1080x1920' } })
    await adapter.ensureRunning()
    const args = runner.spawns[0]!.args
    assert.equal(args[args.indexOf('-skin') + 1], '1080x1920')
  })

  test('cancelStart：取消启动会 SIGTERM 自己 spawn 的实例', async () => {
    const runner = new FakeCommandRunner()
    const env = makeEnv()
    env.openPorts.clear()
    const adapter = makeAdapter({ env, runner, emulator: { ...EMULATOR, bootTimeoutMs: 5_000 } })
    const booting = adapter.ensureRunning()
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    await adapter.cancelStart()
    await assert.rejects(booting)
    assert.ok(runner.kills.some((kill) => kill.signal === 'SIGTERM'))
  })
})
