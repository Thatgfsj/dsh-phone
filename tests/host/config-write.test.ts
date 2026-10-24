import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ConfigWriteError,
  deepEqual,
  describeEntry,
  isWritablePath,
  readPath,
  writeConfigValue,
} from '../../src/config/write.ts'
import type { SettingsDescriptorLike, SettingsFacade, SettingsPathOpLike } from '../../src/config/write.ts'

interface FakeSettings extends SettingsFacade {
  calls: { ops: readonly SettingsPathOpLike[]; revision?: number }[]
  /** 让第 n 次 mutate 抛 revision 冲突。 */
  conflictTimes: number
  /** 写入后忽略（模拟回读不一致）。 */
  ignoreWrites: boolean
}

function makeSettings(initial = { attach: { endpoint: '', userHint: '', resolved: false } }): FakeSettings {
  let value = structuredClone(initial)
  let revision = 7
  const settings: FakeSettings = {
    calls: [],
    conflictTimes: 0,
    ignoreWrites: false,
    describe() {
      return [{ ns: 'dsh-phone', revision, value: structuredClone(value) } as SettingsDescriptorLike]
    },
    async mutate(ns, ops, expectedRevision) {
      settings.calls.push({ ops, revision: expectedRevision })
      if (settings.conflictTimes > 0) {
        settings.conflictTimes -= 1
        throw Object.assign(new Error('revision mismatch'), {
          name: 'SettingsConflictError',
          code: 'SETTINGS_CONFLICT',
        })
      }
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw Object.assign(new Error('revision mismatch'), {
          name: 'SettingsConflictError',
          code: 'SETTINGS_CONFLICT',
        })
      }
      revision += 1
      if (settings.ignoreWrites) return
      for (const op of ops) {
        let target = value as Record<string, unknown>
        for (const segment of op.path.slice(0, -1)) {
          target = target[segment] as Record<string, unknown>
        }
        target[op.path[op.path.length - 1]!] = op.value
      }
    },
  }
  return settings
}

test('isWritablePath：只允许 SPEC §6.2 R1 的三个键', () => {
  assert.ok(isWritablePath(['attach', 'endpoint']))
  assert.ok(isWritablePath(['attach', 'resolved']))
  assert.ok(isWritablePath(['attach', 'userHint']))
  assert.ok(isWritablePath(['onboarding', 'status']))
  assert.ok(isWritablePath(['onboarding', 'choice']))
  assert.equal(isWritablePath(['onboarding']), false)
  assert.equal(isWritablePath(['runtime']), false)
  assert.equal(isWritablePath(['attach', 'endpoint', 'x']), false)
  assert.equal(isWritablePath(['stream', 'maxSize']), false)
})

test('writeConfigValue：单键 set + revision + 回读（R1/R4）', async () => {
  const settings = makeSettings()
  const result = await writeConfigValue(settings, ['attach', 'userHint'], '模拟器在 D:\\Android\\Sdk', 7)
  assert.equal(settings.calls.length, 1)
  assert.deepEqual(settings.calls[0]!.ops, [
    { op: 'set', path: ['attach', 'userHint'], value: '模拟器在 D:\\Android\\Sdk' },
  ])
  assert.equal(settings.calls[0]!.revision, 7)
  assert.equal(result.revision, 8)
  assert.equal(readPath(result.value, ['attach', 'userHint']), '模拟器在 D:\\Android\\Sdk')
})

test('writeConfigValue：非白名单路径直接拒绝（不调用 mutate）', async () => {
  const settings = makeSettings()
  await assert.rejects(
    writeConfigValue(settings, ['runtime'], 'attach'),
    (error: unknown) => error instanceof ConfigWriteError && error.code === 'bad-path',
  )
  assert.equal(settings.calls.length, 0)
})

test('writeConfigValue：revision 冲突自动重读重试一次', async () => {
  const settings = makeSettings()
  settings.conflictTimes = 1
  const result = await writeConfigValue(settings, ['attach', 'endpoint'], '127.0.0.1:5555', 3)
  assert.equal(settings.calls.length, 2)
  assert.equal(settings.calls[0]!.revision, 3)
  assert.equal(settings.calls[1]!.revision, 7)
  assert.equal(readPath(result.value, ['attach', 'endpoint']), '127.0.0.1:5555')
})

test('writeConfigValue：连续两次冲突 → ConfigWriteError(conflict)', async () => {
  const settings = makeSettings()
  settings.conflictTimes = 2
  await assert.rejects(
    writeConfigValue(settings, ['attach', 'endpoint'], '127.0.0.1:5555', 3),
    (error: unknown) => error instanceof ConfigWriteError && error.code === 'conflict',
  )
})

test('writeConfigValue：回读不一致 → ConfigWriteError(verify)（R4 双验证）', async () => {
  const settings = makeSettings()
  settings.ignoreWrites = true
  await assert.rejects(
    writeConfigValue(settings, ['attach', 'resolved'], true, 7),
    (error: unknown) => error instanceof ConfigWriteError && error.code === 'verify',
  )
})

test('describeEntry：settings 缺失 / 命名空间缺失分别报错', () => {
  assert.throws(
    () => describeEntry(undefined),
    (error: unknown) => error instanceof ConfigWriteError && error.code === 'no-settings',
  )
  const empty: SettingsFacade = { describe: () => [], mutate: async () => {} }
  assert.throws(
    () => describeEntry(empty),
    (error: unknown) => error instanceof ConfigWriteError && error.code === 'no-entry',
  )
})

test('readPath / deepEqual 工具函数', () => {
  assert.equal(readPath({ attach: { resolved: true } }, ['attach', 'resolved']), true)
  assert.equal(readPath({}, ['attach', 'resolved']), undefined)
  assert.ok(deepEqual({ a: [1, 2], b: { c: 'x' } }, { b: { c: 'x' }, a: [1, 2] }))
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false)
  assert.equal(deepEqual([1], { 0: 1 }), false)
})