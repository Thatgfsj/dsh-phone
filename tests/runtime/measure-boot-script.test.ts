import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  assertSafeConsolePort,
  chooseSystemImage,
  emulatorArgs,
  isPortFree,
  isPortListening,
  parseArgs,
} from '../../scripts/verify/measure-boot.mjs'

const tempDirs: string[] = []
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

describe('measure-boot.mjs：参数与端口安全（issue #67）', () => {
  test('默认只使用 >=5556 的独立端口（不碰用户 5554/5555）', () => {
    const options = parseArgs([])
    assert.equal(options.consolePort, 5556)
    assert.equal(options.avd, 'dsh-phone-perf')
    assert.equal(options.repeat, 1)
    assert.equal(options.json, false)
  })

  test('自定义参数与非法参数', () => {
    const options = parseArgs(['--avd', 'x', '--console-port', '5560', '--repeat', '2', '--json', '--out', '/tmp/a.json'])
    assert.equal(options.avd, 'x')
    assert.equal(options.consolePort, 5560)
    assert.equal(options.repeat, 2)
    assert.equal(options.json, true)
    assert.equal(options.out, '/tmp/a.json')
    assert.throws(() => parseArgs(['--unknown']), /未知参数/)
    assert.throws(() => parseArgs(['--repeat', '0']), /repeat/)
  })

  test('assertSafeConsolePort 拒绝 5554/5555（保护用户实例）', () => {
    assert.throws(() => assertSafeConsolePort(5554), /保护 5554\/5555/)
    assert.throws(() => assertSafeConsolePort(5555), /保护 5554\/5555/)
    assert.equal(assertSafeConsolePort(5556), 5556)
    assert.equal(assertSafeConsolePort(5558), 5558)
  })

  test('isPortListening（connect 探测，不占端口）与 isPortFree（bind 探测）互补', async () => {
    const server = createServer(() => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    try {
      assert.equal(await isPortListening(port), true)
      assert.equal(await isPortFree(port), false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    assert.equal(await isPortListening(port), false)
    // 关闭后立即 rebind 偶发 EADDRINUSE（TIME_WAIT），最多重试 2s
    const deadline = Date.now() + 2_000
    let free = false
    while (!free && Date.now() < deadline) {
      free = await isPortFree(port)
      if (!free) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(free, true)
  })
})

describe('measure-boot.mjs：emulator 参数与镜像选择', () => {
  test('冷启动带 -no-snapshot-load；快照启动不带；都带调优 flag 与 -snapshot default_boot', () => {
    const cold = emulatorArgs('dsh-phone-perf', 5556, 'cold')
    const snapshot = emulatorArgs('dsh-phone-perf', 5556, 'snapshot')
    assert.ok(cold.includes('-no-snapshot-load'))
    assert.equal(snapshot.includes('-no-snapshot-load'), false)
    for (const args of [cold, snapshot]) {
      assert.equal(args[args.indexOf('-snapshot') + 1], 'default_boot')
      assert.ok(args.includes('-no-boot-anim'))
      assert.ok(args.includes('-no-metrics'))
      assert.ok(args.includes('-no-window'))
      assert.equal(args[args.indexOf('-port') + 1], '5556')
      // issue #67：默认不用 -skin 覆盖 AVD skin/density（仅 DSH_MEASURE_SKIN 显式指定时传）
      assert.equal(args.includes('-skin'), false)
    }
    assert.equal(cold.includes('-no-snapshot-save'), false)
  })

  test('chooseSystemImage：优先 aosp_atd，其次 google_apis x86_64，显式值直通', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-measure-images-'))
    tempDirs.push(root)
    const aospDir = join(root, 'system-images', 'android-34', 'aosp_atd', 'x86_64')
    await mkdir(aospDir, { recursive: true })
    await writeFile(join(aospDir, 'system.img'), '')
    assert.equal(
      await chooseSystemImage(root, ''),
      'system-images;android-34;aosp_atd;x86_64',
    )

    const root2 = await mkdtemp(join(tmpdir(), 'dsh-measure-images2-'))
    tempDirs.push(root2)
    const googleDir = join(root2, 'system-images', 'android-34', 'google_apis', 'x86_64')
    await mkdir(googleDir, { recursive: true })
    assert.equal(
      await chooseSystemImage(root2, ''),
      'system-images;android-34;google_apis;x86_64',
    )
    assert.equal(await chooseSystemImage(root2, 'system-images;android-34;google_apis;x86_64'), 'system-images;android-34;google_apis;x86_64')

    const empty = await mkdtemp(join(tmpdir(), 'dsh-measure-images3-'))
    tempDirs.push(empty)
    await assert.rejects(chooseSystemImage(empty, ''), /没有已安装的 system image/)
  })
})
