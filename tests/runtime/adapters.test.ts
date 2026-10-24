import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AttachRuntime } from '../../src/runtime/attach.ts'
import { EmulatorRuntime } from '../../src/runtime/emulator.ts'
import { RedroidRuntime } from '../../src/runtime/redroid.ts'
import { RuntimeError } from '../../src/runtime/types.ts'
import type { EmulatorOptions, RedroidOptions } from '../../src/runtime/types.ts'
import { FakeCommandRunner, FakeEnvironment } from '../fake-adb/runtime.ts'

const REDROID: RedroidOptions = {
  image: 'redroid/redroid:14-latest',
  memLimit: '2g',
  vcpuLimit: 2,
}

const EMULATOR: EmulatorOptions = { avdName: 'dsh-phone-avd', resolution: '720x1280' }

function dockerEnv(): FakeEnvironment {
  const env = new FakeEnvironment()
  env.platformValue = 'linux'
  env.commands.add('docker')
  env.paths.add('/dev/binder')
  env.openPorts.add(5555)
  return env
}

describe('RedroidRuntime（假 docker CLI）', () => {
  test('容器不存在 → docker run 创建并把端口映射到 loopback，返回 endpoint', async () => {
    const runner = new FakeCommandRunner().dockerInspect(undefined)
    const env = dockerEnv()
    const adapter = new RedroidRuntime({
      redroid: REDROID,
      deps: { env, runner },
    })
    const progress: string[] = []
    const endpoint = await adapter.ensureRunning((message) => progress.push(message))
    assert.deepEqual(endpoint, { host: '127.0.0.1', port: 5555 })
    const run = runner.calls.find((call) => call.args[0] === 'run')
    assert.ok(run)
    assert.deepEqual(run.args.slice(0, 2), ['run', '-d'])
    assert.ok(run.args.includes('--privileged'))
    assert.ok(run.args.includes('--memory') && run.args.includes('2g'))
    assert.ok(run.args.includes('--cpus') && run.args.includes('2'))
    assert.ok(run.args.includes('127.0.0.1:5555:5555'))
    assert.equal(run.args.at(-1), REDROID.image)
    assert.ok(progress.some((message) => /创建 redroid 容器/.test(message)))
  })

  test('容器已存在但 stopped → docker start；paused → docker unpause', async () => {
    const runner = new FakeCommandRunner().dockerInspect('exited')
    const adapter = new RedroidRuntime({
      redroid: REDROID,
      deps: { env: dockerEnv(), runner },
    })
    await adapter.ensureRunning()
    assert.ok(runner.calls.some((call) => call.args[0] === 'start'))

    const pausedRunner = new FakeCommandRunner().dockerInspect('paused')
    const paused = new RedroidRuntime({
      redroid: REDROID,
      deps: { env: dockerEnv(), runner: pausedRunner },
    })
    await paused.resume()
    assert.ok(pausedRunner.calls.some((call) => call.args[0] === 'unpause'))
  })

  test('已 running → 不重复创建/启动，直接等端口', async () => {
    const runner = new FakeCommandRunner().dockerInspect('running', 'abc123')
    const adapter = new RedroidRuntime({
      redroid: REDROID,
      deps: { env: dockerEnv(), runner },
    })
    await adapter.ensureRunning()
    const verbs = runner.calls.map((call) => call.args[0])
    assert.deepEqual(verbs, ['inspect'])
    const status = await adapter.status()
    assert.equal(status.running, true)
    assert.equal(status.containerId, 'abc123')
  })

  test('pause → docker pause；stop → docker stop', async () => {
    const runner = new FakeCommandRunner().dockerInspect('running')
    const adapter = new RedroidRuntime({
      redroid: REDROID,
      deps: { env: dockerEnv(), runner },
    })
    await adapter.pause()
    await adapter.stop()
    assert.ok(runner.calls.some((call) => call.args[0] === 'pause'))
    assert.ok(runner.calls.some((call) => call.args[0] === 'stop'))
  })

  test('Docker 守护进程不可用 → 明确报错（不误判为容器不存在）', async () => {
    const runner = new FakeCommandRunner().on(
      (file, args) => file === 'docker' && args[0] === 'inspect',
      () => ({
        code: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
        timedOut: false,
      }),
    )
    const adapter = new RedroidRuntime({
      redroid: REDROID,
      deps: { env: dockerEnv(), runner },
    })
    await assert.rejects(adapter.ensureRunning(), (error: unknown) => {
      assert.ok(error instanceof RuntimeError)
      assert.match(error.message, /Docker 守护进程不可用/)
      return true
    })
  })

  test('端口迟迟不开放 → 启动失败并提示 docker logs', async () => {
    const runner = new FakeCommandRunner().dockerInspect('running')
    const env = dockerEnv()
    env.openPorts.delete(5555)
    const adapter = new RedroidRuntime({ redroid: REDROID, deps: { env, runner } })
    await assert.rejects(adapter.ensureRunning(), /adbd 未就绪.*docker logs/)
  })
})

describe('EmulatorRuntime（假 emulator 可执行文件）', () => {
  test('无 AVD 列表时使用配置的 avdName，拉起 headless 并等端口', async () => {
    const runner = new FakeCommandRunner()
    const env = new FakeEnvironment()
    env.platformValue = 'linux'
    env.emulatorPath = '/fake/sdk/emulator/emulator'
    env.openPorts.add(5555)
    const adapter = new EmulatorRuntime({
      emulator: EMULATOR,
      deps: { env, runner },
    })
    const endpoint = await adapter.ensureRunning()
    assert.deepEqual(endpoint, { host: '127.0.0.1', port: 5555 })
    assert.equal(runner.spawns.length, 1)
    const args = runner.spawns[0]!.args
    assert.equal(args[0], '-avd')
    assert.equal(args[1], 'dsh-phone-avd')
    assert.ok(args.includes('-no-window'))
    assert.ok(args.includes('-skin') && args.includes('720x1280'))
    assert.ok(args.includes('-port') && args.includes('5554'))
    assert.equal(adapter.kind, 'emulator')
    const status = await adapter.status()
    assert.equal(status.running, true)
    assert.ok(status.pid !== undefined)
  })

  test('avdName 为空 → 用 -list-avds 的第一个 AVD', async () => {
    const runner = new FakeCommandRunner().on('/fake/sdk/emulator/emulator', (file, args) =>
      args[0] === '-list-avds'
        ? { code: 0, stdout: 'First_AVD\nSecond_AVD\n', stderr: '', timedOut: false }
        : { code: 0, stdout: '', stderr: '', timedOut: false },
    )
    const env = new FakeEnvironment()
    env.emulatorPath = '/fake/sdk/emulator/emulator'
    env.openPorts.add(5555)
    const adapter = new EmulatorRuntime({
      emulator: { avdName: '', resolution: '' },
      deps: { env, runner },
    })
    await adapter.ensureRunning()
    assert.equal(runner.spawns[0]!.args[1], 'First_AVD')
    assert.equal(runner.spawns[0]!.args.includes('-skin'), false)
  })

  test('ensureRunning 幂等：进程仍活着时不重复拉起', async () => {
    const runner = new FakeCommandRunner()
    const env = new FakeEnvironment()
    env.emulatorPath = '/fake/sdk/emulator/emulator'
    env.openPorts.add(5555)
    const adapter = new EmulatorRuntime({ emulator: EMULATOR, deps: { env, runner } })
    await adapter.ensureRunning()
    await adapter.ensureRunning()
    assert.equal(runner.spawns.length, 1)
  })

  test('pause（SIGTERM 存快照）→ resume 带 -snapshot default_boot 重启', async () => {
    const runner = new FakeCommandRunner()
    const env = new FakeEnvironment()
    env.emulatorPath = '/fake/sdk/emulator/emulator'
    env.openPorts.add(5555)
    const adapter = new EmulatorRuntime({ emulator: EMULATOR, deps: { env, runner } })
    await adapter.ensureRunning()
    await adapter.pause()
    assert.equal(runner.kills[0]!.signal, 'SIGTERM')
    const paused = await adapter.status()
    assert.equal(paused.paused, true)
    assert.equal(paused.running, false)

    await adapter.resume()
    assert.equal(runner.spawns.length, 2)
    const resumeArgs = runner.spawns[1]!.args
    assert.ok(resumeArgs.includes('-snapshot') && resumeArgs.includes('default_boot'))
  })

  test('stop 杀进程并清状态', async () => {
    const runner = new FakeCommandRunner()
    const env = new FakeEnvironment()
    env.emulatorPath = '/fake/sdk/emulator/emulator'
    env.openPorts.add(5555)
    const adapter = new EmulatorRuntime({ emulator: EMULATOR, deps: { env, runner } })
    await adapter.ensureRunning()
    await adapter.stop()
    const status = await adapter.status()
    assert.equal(status.running, false)
    assert.equal(status.pid, undefined)
  })

  test('找不到 emulator → 明确报错（不自动安装）', async () => {
    const adapter = new EmulatorRuntime({
      emulator: EMULATOR,
      deps: { env: new FakeEnvironment(), runner: new FakeCommandRunner() },
    })
    await assert.rejects(adapter.ensureRunning(), /未找到 Android SDK emulator/)
  })
})

describe('AttachRuntime（只连接校验，不启动外部进程）', () => {
  test('endpoint 已配置且可达 → ensureRunning 返回 endpoint', async () => {
    const env = new FakeEnvironment()
    env.openPorts.add(5555)
    const adapter = new AttachRuntime({
      attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
      env,
    })
    const endpoint = await adapter.ensureRunning()
    assert.deepEqual(endpoint, { host: '127.0.0.1', port: 5555 })
    const status = await adapter.status()
    assert.equal(status.running, true)
    assert.equal(status.paused, false)
  })

  test('只解析出 userHint（endpoint 未解析）→ attach-unresolved 错误', async () => {
    const adapter = new AttachRuntime({
      attach: { endpoint: '', userHint: '雷电模拟器默认位置', resolved: false },
      env: new FakeEnvironment(),
    })
    await assert.rejects(adapter.ensureRunning(), (error: unknown) => {
      assert.ok(error instanceof RuntimeError)
      assert.equal(error.code, 'attach-unresolved')
      assert.match(error.message, /待解析/)
      return true
    })
    const probe = await adapter.probe()
    assert.equal(probe.ok, false)
    assert.match(probe.reason ?? '', /待解析/)
  })

  test('endpoint 不可达 → start 错误（不启动外部进程）', async () => {
    const env = new FakeEnvironment()
    const adapter = new AttachRuntime({
      attach: { endpoint: '127.0.0.1:5557', userHint: '', resolved: true },
      env,
    })
    await assert.rejects(adapter.ensureRunning(), (error: unknown) => {
      assert.ok(error instanceof RuntimeError)
      assert.equal(error.code, 'start')
      assert.match(error.message, /不可达/)
      return true
    })
  })

  test('pause/stop 不改实例（attach 不是插件资源）', async () => {
    const env = new FakeEnvironment()
    env.openPorts.add(5555)
    const adapter = new AttachRuntime({
      attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true },
      env,
    })
    await adapter.ensureRunning()
    await adapter.pause()
    await adapter.resume()
    await adapter.stop()
    const status = await adapter.status()
    // status 重新探测端口：实例仍在跑，因此仍报 running（只断开连接，不停实例）
    assert.equal(status.running, true)
    assert.equal(status.paused, false)
  })
})
