import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  avdmanagerCandidates,
  findAvdManagerPath,
  parseProcMeminfoTotalKb,
  parseProcStatJiffies,
  parseProcStatusRssKb,
} from '../../src/runtime/probe.ts'
import {
  ATTACH_CPU_COMMAND,
  ATTACH_MEM_COMMAND,
  parseDumpsysCpuinfoPct,
  parseMeminfoPct,
  usageFromAttachOutputs,
} from '../../src/phone/usage.ts'
import { FakeCommandRunner } from '../fake-adb/runtime.ts'

const DUMPSYS = [
  'Load: 1.42 / 1.31 / 1.20',
  'CPU usage from 0ms to 60000ms later:',
  '  2.1% 1234/com.android.systemui: 1.2% user + 0.9% kernel',
  'TOTAL: 5.2% user + 3.1% kernel + 0.4% iowait',
].join('\n')

const MEMINFO = [
  'MemTotal:        3891200 kB',
  'MemFree:          120000 kB',
  'MemAvailable:    1500000 kB',
  'Buffers:           40000 kB',
  'Cached:           800000 kB',
].join('\n')

describe('attach 资源占用解析（issue #56）', () => {
  test('dumpsys cpuinfo 的 TOTAL 行 = user + kernel', () => {
    assert.equal(parseDumpsysCpuinfoPct(DUMPSYS), 8.3)
    assert.equal(parseDumpsysCpuinfoPct('Load: 1.0 / 1.0'), undefined)
  })

  test('meminfo 优先用 MemAvailable 计算已用百分比', () => {
    assert.equal(parseMeminfoPct(MEMINFO), 61.5)
  })

  test('没有 MemAvailable 时用 Free + Buffers + Cached 兜底', () => {
    const text = ['MemTotal: 1000 kB', 'MemFree: 100 kB', 'Buffers: 100 kB', 'Cached: 200 kB'].join('\n')
    assert.equal(parseMeminfoPct(text), 60)
    assert.equal(parseMeminfoPct('not meminfo'), undefined)
  })

  test('usageFromAttachOutputs 只填能解析的字段', () => {
    assert.deepEqual(usageFromAttachOutputs(DUMPSYS, MEMINFO), { cpuPct: 8.3, memPct: 61.5 })
    assert.deepEqual(usageFromAttachOutputs('garbage', 'garbage'), {})
    assert.equal(ATTACH_CPU_COMMAND, 'dumpsys cpuinfo')
    assert.equal(ATTACH_MEM_COMMAND, 'cat /proc/meminfo')
  })
})

describe('/proc 解析（emulator 资源占用，issue #56）', () => {
  // 第 3 字段起：state、ppid、...；utime=第 14、stime=第 15（此处用 101/202 标记）
  const STAT =
    '1234 (qemu-system-x86) S 1 1234 1234 0 -1 4194560 1000 0 0 0 101 202 0 0 20 0 8 0 100 200 0'

  test('parseProcStatJiffies = utime + stime', () => {
    assert.equal(parseProcStatJiffies(STAT), 303)
    assert.equal(parseProcStatJiffies('broken'), undefined)
  })

  test('parseProcStatusRssKb / parseProcMeminfoTotalKb', () => {
    assert.equal(parseProcStatusRssKb('Name:\tqemu\nVmRSS:\t 204800 kB\n'), 204800)
    assert.equal(parseProcStatusRssKb('no rss'), undefined)
    assert.equal(parseProcMeminfoTotalKb('MemTotal:       3891200 kB'), 3891200)
    assert.equal(parseProcMeminfoTotalKb('nope'), undefined)
  })
})

describe('avdmanager 多候选探测（issue #56）', () => {
  test('候选包含 cmdline-tools/latest、各版本通配、SDK tools/bin、ANDROID_HOME', () => {
    const candidates = avdmanagerCandidates('linux', '/sdk/emulator/emulator', {
      ANDROID_HOME: '/android-home',
    })
    assert.ok(candidates.includes('/sdk/cmdline-tools/latest/bin/avdmanager'))
    assert.ok(candidates.some((path) => path.includes('cmdline-tools/*/bin/avdmanager')))
    assert.ok(candidates.includes('/sdk/tools/bin/avdmanager'))
    assert.ok(candidates.includes('/android-home/cmdline-tools/latest/bin/avdmanager'))
  })

  test('windows 用 avdmanager.bat；PATH 回退走 where/which', async () => {
    const candidates = avdmanagerCandidates('windows', undefined, {
      ANDROID_SDK_ROOT: 'C:/Android/Sdk',
    })
    assert.ok(candidates.every((path) => path.endsWith('avdmanager.bat')))

    const runner = new FakeCommandRunner()
    runner.on('which', () => ({ code: 0, stdout: '/usr/bin/avdmanager\n', stderr: '', timedOut: false }))
    const found = await findAvdManagerPath(runner, '/nonexistent/sdk/emulator/emulator')
    // 本机是 linux，which 返回应该被当成 PATH 回退（若存在真实 avdmanager 则返回真实路径）
    assert.equal(typeof found, 'string')
  })
})
