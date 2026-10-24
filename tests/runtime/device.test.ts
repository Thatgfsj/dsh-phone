import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AdbDevice } from '../../src/adb/device.ts'
import { AdbError } from '../../src/adb/types.ts'
import { FakeAdbConnection } from '../fake-adb/connection.ts'

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
])

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

describe('AdbDevice：截图', () => {
  test('screencap → base64 取回 → 删除临时文件，返回 PNG', async () => {
    const connection = new FakeAdbConnection()
    connection
      .on(/^screencap -p \/sdcard\/\.dsh-phone-/, '')
      .on(/^base64 \/sdcard\/\.dsh-phone-/, `${base64(PNG).slice(0, 8)}\n${base64(PNG).slice(8)}\n`)
      .on(/^rm -f \/sdcard\/\.dsh-phone-/, '')
    const device = new AdbDevice(connection)

    const bytes = await device.screenshot()
    assert.deepEqual([...bytes], [...PNG])
    assert.equal(connection.commands.length, 3)
    assert.match(connection.commands[0]!, /^screencap -p \/sdcard\/\.dsh-phone-.*\.png$/)
    assert.match(connection.commands[1]!, /^base64 /)
    assert.equal(connection.commands[2], connection.commands[1]!.replace('base64', 'rm -f'))
  })

  test('screencap 失败（无内容）时抛错，但临时文件仍被删除', async () => {
    const connection = new FakeAdbConnection()
    connection
      .on(/^screencap -p /, '')
      .on(/^base64 /, '')
      .on(/^rm -f /, '')
    const device = new AdbDevice(connection)
    await assert.rejects(device.screenshot(), (error: unknown) => {
      assert.ok(error instanceof AdbError)
      assert.equal(error.code, 'protocol')
      return true
    })
    assert.match(connection.commands.at(-1)!, /^rm -f /)
  })

  test('base64 内容混入错误输出 → 抛 protocol 错误', async () => {
    const connection = new FakeAdbConnection()
    connection
      .on(/^screencap /, '')
      .on(/^base64 /, 'base64: /sdcard/x.png: No such file or directory\n')
      .on(/^rm -f /, '')
    const device = new AdbDevice(connection)
    await assert.rejects(device.screenshot(), /base64 内容非法/)
  })

  test('非 PNG 内容（被文本污染）→ 抛 protocol 错误', async () => {
    const connection = new FakeAdbConnection()
    const bad = new Uint8Array([0x01, 0x02, 0x03])
    connection.on(/^screencap /, '').on(/^base64 /, base64(bad)).on(/^rm -f /, '')
    const device = new AdbDevice(connection)
    await assert.rejects(device.screenshot(), /不是有效 PNG/)
  })
})

describe('AdbDevice：输入与控件树', () => {
  test('tap / swipe / key / appLaunch 生成正确 shell 命令', async () => {
    const connection = new FakeAdbConnection()
    connection
      .on(/^input tap /, '')
      .on(/^input swipe /, '')
      .on(/^input keyevent /, '')
      .on(/^monkey /, '')
    const device = new AdbDevice(connection)
    await device.tap(100, 200)
    await device.swipe(1, 2, 3, 4, 500)
    await device.key('HOME')
    await device.key('back')
    await device.key('66')
    await device.appLaunch('com.android.settings')
    assert.deepEqual(connection.commands, [
      'input tap 100 200',
      'input swipe 1 2 3 4 500',
      'input keyevent KEYCODE_HOME',
      'input keyevent KEYCODE_BACK',
      'input keyevent 66',
      'monkey -p com.android.settings -c android.intent.category.LAUNCHER 1',
    ])
  })

  test('非法坐标/包名在发命令前就被拒绝', async () => {
    const connection = new FakeAdbConnection()
    const device = new AdbDevice(connection)
    await assert.rejects(device.tap(-1, 2), /x 必须是非负整数/)
    await assert.rejects(device.swipe(0, 0, 1.5, 2), /x2 必须是非负整数/)
    await assert.rejects(device.appLaunch('bad;rm -rf /'), /包名非法/)
    assert.equal(connection.commands.length, 0)
  })

  test('uiautomator dump + cat，xml 非法时报错并清理', async () => {
    const connection = new FakeAdbConnection()
    connection
      .on(/^uiautomator dump /, 'UI hierchary dumped to: /sdcard/x.xml')
      .on(/^cat /, '<hierarchy><node text="hi"/></hierarchy>')
      .on(/^rm -f /, '')
    const device = new AdbDevice(connection)
    const xml = await device.dumpUi()
    assert.match(xml, /<hierarchy>/)
    assert.equal(connection.commands.length, 3)

    const broken = new FakeAdbConnection()
    broken.on(/^uiautomator dump /, 'ERROR: could not get idle state.').on(/^cat /, '').on(/^rm -f /, '')
    await assert.rejects(new AdbDevice(broken).dumpUi(), /不是有效控件树/)
    assert.match(broken.commands.at(-1)!, /^rm -f /)
  })

  test('shell 直接透传命令', async () => {
    const connection = new FakeAdbConnection()
    connection.on(/^getprop /, 'ro.product.model=Pixel\n')
    const device = new AdbDevice(connection)
    assert.equal(await device.shell('getprop ro.product.model'), 'ro.product.model=Pixel\n')
  })
})
