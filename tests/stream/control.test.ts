import assert from 'node:assert/strict'
import { test } from 'node:test'

import { KEY_CODES, resolveKeyCode, ScrcpyController } from '../../src/stream/control.ts'

interface Recorded {
  kind: 'text' | 'touch' | 'key'
  payload: unknown
}

function fakeWriter(): { calls: Recorded[]; writer: unknown } {
  const calls: Recorded[] = []
  const writer = {
    async injectText(text: string) {
      calls.push({ kind: 'text', payload: text })
    },
    async injectTouch(message: unknown) {
      calls.push({ kind: 'touch', payload: message })
    },
    async injectKeyCode(message: unknown) {
      calls.push({ kind: 'key', payload: message })
    },
    releaseLock() {},
  }
  return { calls, writer }
}

test('injectText 原样传递 UTF-8 中文（走 INJECT_TEXT）', async () => {
  const { calls, writer } = fakeWriter()
  const controller = new ScrcpyController(writer as never, { width: 720, height: 1280 })
  await controller.injectText('你好，世界 🌏')
  assert.deepEqual(calls, [{ kind: 'text', payload: '你好，世界 🌏' }])
  await controller.injectText('')
  assert.equal(calls.length, 1, '空字符串不产生 control message')
})

test('injectTouch 映射 down/move/up 并夹取设备坐标', async () => {
  const { calls, writer } = fakeWriter()
  const controller = new ScrcpyController(writer as never, { width: 720, height: 1280 })
  await controller.injectTouch('down', 100, 200)
  await controller.injectTouch('move', 5000, -20)
  await controller.injectTouch('up', 100, 200)

  const messages = calls.map((call) => call.payload as Record<string, unknown>)
  assert.equal(messages[0]?.action, 0)
  assert.equal(messages[0]?.pointerX, 100)
  assert.equal(messages[0]?.pointerY, 200)
  assert.equal(messages[0]?.pressure, 1)
  assert.equal(messages[1]?.action, 2)
  assert.equal(messages[1]?.pointerX, 719, 'x 夹到 width-1')
  assert.equal(messages[1]?.pointerY, 0, 'y 夹到 0')
  assert.equal(messages[2]?.action, 1)
  assert.equal(messages[2]?.pressure, 0)
  assert.equal((messages[0]?.pointerId as bigint), 0n)
  assert.equal(messages[0]?.videoWidth, 720)
  assert.equal(messages[0]?.videoHeight, 1280)
})

test('setScreenSize 更新触摸基准', async () => {
  const { calls, writer } = fakeWriter()
  const controller = new ScrcpyController(writer as never, { width: 720, height: 1280 })
  controller.setScreenSize(1080, 1920)
  await controller.injectTouch('down', 1080, 1920)
  const message = calls[0]?.payload as Record<string, unknown>
  assert.equal(message.videoWidth, 1080)
  assert.equal(message.pointerX, 1079)
})

test('injectKey 发送 down + up 两个事件', async () => {
  const { calls, writer } = fakeWriter()
  const controller = new ScrcpyController(writer as never, { width: 720, height: 1280 })
  await controller.injectKey('home')
  assert.equal(calls.length, 2)
  const down = calls[0]?.payload as Record<string, unknown>
  const up = calls[1]?.payload as Record<string, unknown>
  assert.equal(down.keyCode, KEY_CODES.HOME)
  assert.equal(down.action, 0)
  assert.equal(up.action, 1)
})

test('按键名解析：大小写不敏感、别名、未知名报错', () => {
  assert.equal(resolveKeyCode('HOME'), 3)
  assert.equal(resolveKeyCode('back'), 4)
  assert.equal(resolveKeyCode('recents'), KEY_CODES.RECENTS)
  assert.equal(resolveKeyCode('app_switch'), KEY_CODES.RECENTS)
  assert.equal(resolveKeyCode('DEL'), 67)
  assert.throws(() => resolveKeyCode('NOT_A_KEY'), /未知按键名/)
})

test('设备坐标按 wm size 换算为 scrcpy 视频坐标（降采样不偏移）', async () => {
  const { calls, writer } = fakeWriter()
  const controller = new ScrcpyController(writer as never, { width: 720, height: 1600 })
  controller.setDeviceSize(1080, 2400)
  assert.deepEqual(controller.deviceSize, { width: 1080, height: 2400 })

  await controller.injectTouch('down', 540, 1200)
  const message = calls[0]?.payload as Record<string, unknown>
  assert.equal(message.pointerX, 360)
  assert.equal(message.pointerY, 800)
  assert.equal(message.videoWidth, 720)
  assert.equal(message.videoHeight, 1600)

  await controller.injectTouch('move', 5000, 5000)
  const clamped = calls[1]?.payload as Record<string, unknown>
  assert.equal(clamped.pointerX, 719, '按视频坐标夹到 720-1')
  assert.equal(clamped.pointerY, 1599, '按视频坐标夹到 1600-1')
})

test('control 关闭后注入报错而不是静默丢弃', async () => {
  const { writer } = fakeWriter()
  const controller = new ScrcpyController(writer as never, { width: 720, height: 1280 })
  controller.close()
  await assert.rejects(controller.injectText('x'), /控制通道不可用/)
  await assert.rejects(controller.injectTouch('down', 1, 1), /控制通道不可用/)
  await assert.rejects(controller.injectKey('HOME'), /控制通道不可用/)
})
