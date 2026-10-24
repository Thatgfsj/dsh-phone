import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  detectRuntime,
  installGuide,
  preferredRuntime,
} from '../../src/runtime/detect.ts'
import {
  DEFAULT_RUNTIME_OPTIONS,
  RuntimeUnavailableError,
} from '../../src/runtime/types.ts'
import type { RuntimeOptions } from '../../src/runtime/types.ts'
import { FakeEnvironment } from '../fake-adb/runtime.ts'

function options(overrides: Partial<RuntimeOptions> = {}): RuntimeOptions {
  return {
    ...DEFAULT_RUNTIME_OPTIONS,
    redroid: { ...DEFAULT_RUNTIME_OPTIONS.redroid },
    emulator: { ...DEFAULT_RUNTIME_OPTIONS.emulator },
    attach: { ...DEFAULT_RUNTIME_OPTIONS.attach },
    ...overrides,
  }
}

function linuxWithDocker(): FakeEnvironment {
  const env = new FakeEnvironment()
  env.platformValue = 'linux'
  env.commands.add('docker')
  env.paths.add('/dev/binder')
  return env
}

describe('detect：SPEC §3.1 决策树', () => {
  test('第 1 步命中：Docker + Linux + /dev/binder → redroid', async () => {
    const env = linuxWithDocker()
    const result = await detectRuntime(options(), env)
    assert.equal(result.kind, 'redroid')
    assert.equal(result.platform, 'linux')
    assert.equal(result.steps.length, 1)
    assert.equal(result.steps[0]!.step, 'redroid')
    assert.equal(result.steps[0]!.ok, true)
    assert.match(result.reason, /redroid/)
  })

  test('第 1 步失败（有 docker 但无 /dev/binder）→ 第 2 步 emulator', async () => {
    const env = linuxWithDocker()
    env.paths.delete('/dev/binder')
    env.emulatorPath = '/fake/sdk/emulator/emulator'
    env.accelerationResult = { ok: true, detail: '/dev/kvm 可用' }
    const result = await detectRuntime(options(), env)
    assert.equal(result.kind, 'emulator')
    assert.equal(result.steps[0]!.step, 'redroid')
    assert.equal(result.steps[0]!.ok, false)
    assert.match(result.steps[0]!.detail, /binder/)
    assert.equal(result.steps[1]!.ok, true)
  })

  test('docker 存在但平台非 Linux → redroid 被跳过', async () => {
    const env = new FakeEnvironment()
    env.platformValue = 'windows'
    env.commands.add('docker')
    env.emulatorPath = 'C:/sdk/emulator/emulator.exe'
    env.accelerationResult = { ok: true, detail: 'WHPX 可用' }
    const result = await detectRuntime(options(), env)
    assert.equal(result.kind, 'emulator')
    assert.match(result.steps[0]!.detail, /仅支持 Linux/)
  })

  test('emulator 存在但虚拟化不可用 → 继续走 attach', async () => {
    const env = new FakeEnvironment()
    env.emulatorPath = '/fake/sdk/emulator/emulator'
    env.accelerationResult = { ok: false, reason: '缺少 /dev/kvm' }
    const result = await detectRuntime(
      options({ attach: { endpoint: '127.0.0.1:5555', userHint: '', resolved: true } }),
      env,
    )
    assert.equal(result.kind, 'attach')
    assert.equal(result.steps[1]!.ok, false)
    assert.match(result.steps[1]!.detail, /kvm/)
  })

  test('第 3 步命中：仅 userHint 待解析也返回 attach', async () => {
    const env = new FakeEnvironment()
    const result = await detectRuntime(
      options({ attach: { endpoint: '', userHint: '雷电模拟器默认位置', resolved: false } }),
      env,
    )
    assert.equal(result.kind, 'attach')
    assert.match(result.steps[result.steps.length - 1]!.detail, /待解析/)
  })

  test('第 4 步：全失败抛 RuntimeUnavailableError（含安装指引）', async () => {
    const env = new FakeEnvironment()
    env.platformValue = 'linux'
    await assert.rejects(detectRuntime(options(), env), (error: unknown) => {
      assert.ok(error instanceof RuntimeUnavailableError)
      assert.equal(error.kind, 'redroid')
      assert.equal(error.platform, 'linux')
      assert.equal(error.steps.length, 4)
      assert.equal(error.steps[3]!.step, 'fail')
      const text = error.hints.join('\n')
      assert.match(text, /docker/i)
      assert.match(text, /\/dev\/binder/)
      assert.match(text, /attach\.endpoint/)
      return true
    })
  })

  test('windows 全失败指引：WHPX + Android Studio + attach', async () => {
    const env = new FakeEnvironment()
    env.platformValue = 'windows'
    await assert.rejects(detectRuntime(options(), env), (error: unknown) => {
      assert.ok(error instanceof RuntimeUnavailableError)
      assert.equal(error.kind, 'emulator')
      const text = error.hints.join('\n')
      assert.match(text, /WHPX/)
      assert.match(text, /Android Studio/)
      assert.match(text, /attach\.endpoint/)
      return true
    })
  })

  test('macos 全失败指引提到 Hypervisor.framework', async () => {
    const env = new FakeEnvironment()
    env.platformValue = 'macos'
    await assert.rejects(detectRuntime(options(), env), (error: unknown) => {
      assert.ok(error instanceof RuntimeUnavailableError)
      assert.equal(error.kind, 'emulator')
      assert.match(error.hints.join('\n'), /Hypervisor\.framework/)
      return true
    })
  })

  test('显式 runtime 不走决策树', async () => {
    const env = new FakeEnvironment()
    env.platformValue = 'other'
    const result = await detectRuntime(options({ runtime: 'attach' }), env)
    assert.equal(result.kind, 'attach')
    assert.equal(result.steps.length, 1)
    assert.match(result.steps[0]!.detail, /显式配置/)
  })

  test('installGuide 覆盖 unknown 平台（引导 attach）', () => {
    assert.match(installGuide('other'), /attach/)
    assert.equal(preferredRuntime('linux'), 'redroid')
    assert.equal(preferredRuntime('macos'), 'emulator')
    assert.equal(preferredRuntime('other'), 'attach')
  })
})
