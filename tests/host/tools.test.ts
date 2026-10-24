import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PHONE_TOOL_FACTORIES, PHONE_TOOL_NAMES, createPhoneTools, registerPhoneTools } from '../../src/tools/index.ts'
import { RuntimeUnavailableError } from '../../src/runtime/types.ts'
import { makeAttachments, makeService, makeToolHost } from './fakes.ts'

function defs() {
  return createPhoneTools({ service: makeService() })
}

test('9 个工具名与 SPEC §4 完全一致（顺序固定）', () => {
  assert.deepEqual([...PHONE_TOOL_NAMES], [
    'phone_status',
    'phone_screenshot',
    'phone_tap',
    'phone_swipe',
    'phone_key',
    'phone_input_text',
    'phone_app_launch',
    'phone_uiautomator_dump',
    'phone_shell',
  ])
  assert.deepEqual(defs().map((d) => d.name), [...PHONE_TOOL_NAMES])
  assert.equal(PHONE_TOOL_FACTORIES.length, 9)
})

test('参数 schema 严格：tap/swipe/key/input_text/app_launch/shell', () => {
  const map = new Map(defs().map((d) => [d.name, d.parameters as {
    type: string
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }]))

  const expect = (name: string, required: string[], types: Record<string, string>) => {
    const parameters = map.get(name)!
    assert.equal(parameters.type, 'object', name)
    assert.deepEqual(Object.keys(parameters.properties).sort(), Object.keys(types).sort(), name)
    assert.deepEqual([...(parameters.required ?? [])].sort(), [...required].sort(), name)
    for (const [key, type] of Object.entries(types)) {
      assert.equal(parameters.properties[key]!.type, type, name + '.' + key)
    }
  }

  expect('phone_tap', ['x', 'y'], { x: 'integer', y: 'integer' })
  expect('phone_swipe', ['x1', 'y1', 'x2', 'y2', 'durationMs'], {
    x1: 'integer', y1: 'integer', x2: 'integer', y2: 'integer', durationMs: 'integer',
  })
  expect('phone_key', ['name'], { name: 'string' })
  expect('phone_input_text', ['text'], { text: 'string' })
  expect('phone_app_launch', ['pkg'], { pkg: 'string' })
  expect('phone_shell', ['cmd'], { cmd: 'string' })

  for (const name of ['phone_status', 'phone_screenshot', 'phone_uiautomator_dump']) {
    const parameters = map.get(name)!
    assert.deepEqual(parameters.properties, {}, name)
    assert.equal(parameters.required, undefined, name)
  }
})

test('工具描述写清前置条件（坐标为截图/控件树来源等）', () => {
  const descriptions = new Map(defs().map((d) => [d.name, d.description]))
  assert.match(descriptions.get('phone_tap')!, /截图|控件树/)
  assert.match(descriptions.get('phone_swipe')!, /截图|控件树/)
  assert.match(descriptions.get('phone_input_text')!, /中文/)
  assert.match(descriptions.get('phone_input_text')!, /INJECT_TEXT|scrcpy/)
  assert.match(descriptions.get('phone_shell')!, /白名单/)
  assert.match(descriptions.get('phone_shell')!, /审批|ask/)
  assert.match(descriptions.get('phone_status')!, /第一步/)
})

test('booting 中间态：不抛错，返回可重试 E_BOOTING + bootMs', async () => {
  const service = makeService()
  service.setReadiness({ state: 'booting', bootMs: 4200 })
  const tap = createPhoneTools({ service }).find((d) => d.name === 'phone_tap')!
  const value = (await tap.execute({ x: 10, y: 20 }, {} as never)) as any
  assert.equal(value.ok, false)
  assert.equal(value.code, 'E_BOOTING')
  assert.equal(value.retryable, true)
  assert.equal(value.bootMs, 4200)
  const blocks = tap.output.render({ x: 10, y: 20 }, value as never)
  assert.match((blocks[0] as { text: string }).text, /启动|重试/)
  assert.equal(service.calls.includes('tap:10,20'), false)
})

test('tap/swipe/key/input_text/app_launch/dump/shell 正常路径调用 service', async () => {
  const service = makeService()
  const byName = new Map(createPhoneTools({ service }).map((d) => [d.name, d]))

  assert.deepEqual(await byName.get('phone_tap')!.execute({ x: 3, y: 4 }, {} as never), {
    ok: true,
    message: '已点击 (3, 4)',
  })
  await byName.get('phone_swipe')!.execute({ x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 250 }, {} as never)
  await byName.get('phone_key')!.execute({ name: 'HOME' }, {} as never)
  await byName.get('phone_input_text')!.execute({ text: '你好，世界' }, {} as never)
  await byName.get('phone_app_launch')!.execute({ pkg: 'com.android.settings' }, {} as never)

  assert.ok(service.calls.includes('tap:3,4'))
  assert.ok(service.calls.includes('swipe:1,2>3,4@250'))
  assert.ok(service.calls.includes('key:HOME'))
  assert.ok(service.calls.includes('inputText:你好，世界'))
  assert.ok(service.calls.includes('appLaunch:com.android.settings'))

  const dump = (await byName.get('phone_uiautomator_dump')!.execute({}, {} as never)) as any
  assert.equal(dump.ok, true)
  assert.match(dump.message as string, /<hierarchy>/)

  const shell = (await byName.get('phone_shell')!.execute({ cmd: 'getprop ro.product.model' }, {} as never)) as any
  assert.equal(shell.ok, true)
  assert.equal(shell.message, 'model=TestPhone')
})

test('错误映射：runtime unavailable → E_RUNTIME_UNAVAILABLE + 安装指引', async () => {
  const service = makeService()
  const error = Object.assign(new Error('没有可用的 Android 运行时'), {
    code: 'unavailable',
    guide: '请安装 Docker 或 Android SDK Emulator',
  })
  service.failOn('ensureInteractive', error)
  const tap = createPhoneTools({ service }).find((d) => d.name === 'phone_tap')!
  const value = (await tap.execute({ x: 1, y: 1 }, {} as never)) as any
  assert.equal(value.code, 'E_RUNTIME_UNAVAILABLE')
  assert.equal(value.retryable, false)
  assert.match((value.hints ?? []).join('\n'), /Docker/)
})

test('phone_screenshot：有 attachments 输出 image block，渲染 text+image', async () => {
  const service = makeService()
  const attachments = makeAttachments()
  const tool = createPhoneTools({ service, attachments: () => attachments }).find(
    (d) => d.name === 'phone_screenshot',
  )!
  const value = (await tool.execute({}, {} as never)) as any
  assert.equal(value.ok, true)
  assert.equal(value.image.attachmentId, 'att-1')
  assert.equal(value.image.width, 720)
  const blocks = tool.output.render({}, value as never)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { type: 'text', text: value.message })
  assert.equal((blocks[1] as { type: string }).type, 'image')
})

test('phone_status：runtime 不可用 → 结构化 E_RUNTIME_UNAVAILABLE + hints（与其它工具语义一致）', async () => {
  const service = makeService({
    status: async () => {
      throw new RuntimeUnavailableError('attach', ['请安装 Docker 或 Android SDK Emulator'])
    },
  })
  const tool = createPhoneTools({ service }).find((d) => d.name === 'phone_status')!
  const value = (await tool.execute({}, {} as never)) as any
  assert.equal(value.ok, false)
  assert.equal(value.code, 'E_RUNTIME_UNAVAILABLE')
  assert.equal(value.retryable, false)
  assert.match((value.hints ?? []).join('\n'), /Docker/)
  const blocks = tool.output.render({}, value as never)
  assert.match((blocks[0] as { text: string }).text, /E_RUNTIME_UNAVAILABLE/)
  assert.match((blocks[0] as { text: string }).text, /Docker/)
})

test('phone_screenshot：runtime 不可用 → E_RUNTIME_UNAVAILABLE（schema 含 hints，不炸 output 校验）', async () => {
  const service = makeService()
  service.failOn(
    'ensureInteractive',
    Object.assign(new Error('没有可用的 Android 运行时'), {
      code: 'unavailable',
      guide: '请安装 Docker 或 Android SDK Emulator',
    }),
  )
  const tool = createPhoneTools({ service }).find((d) => d.name === 'phone_screenshot')!
  const value = (await tool.execute({}, {} as never)) as any
  assert.equal(value.ok, false)
  assert.equal(value.code, 'E_RUNTIME_UNAVAILABLE')
  assert.match((value.hints ?? []).join('\n'), /Docker/)
  assert.ok(
    Object.keys((tool.output.schema as { properties: Record<string, unknown> }).properties).includes(
      'hints',
    ),
  )
  const blocks = tool.output.render({}, value as never)
  assert.match((blocks[0] as { text: string }).text, /E_RUNTIME_UNAVAILABLE/)
})

test('phone_screenshot：attachment 含 originalDimensions 时只输出 schema 声明字段', async () => {
  const service = makeService()
  const attachments = {
    async saveImage() {
      return {
        attachmentId: 'att-2',
        mediaType: 'image/jpeg' as const,
        bytes: 9,
        width: 360,
        height: 640,
        name: 'x.jpg',
        originalDimensions: { width: 720, height: 1280 },
        extraField: 'should-be-dropped',
      }
    },
  }
  const tool = createPhoneTools({ service, attachments: () => attachments }).find(
    (d) => d.name === 'phone_screenshot',
  )!
  const value = (await tool.execute({}, {} as never)) as any
  assert.equal(value.ok, true)
  assert.deepEqual(value.image, {
    attachmentId: 'att-2',
    mediaType: 'image/jpeg',
    bytes: 9,
    width: 360,
    height: 640,
    name: 'x.jpg',
    originalDimensions: { width: 720, height: 1280 },
  })
  assert.equal('extraField' in value.image, false)
})

test('phone_screenshot：无 attachments 或保存失败时降级文本、不整体失败', async () => {
  const service = makeService()
  const noService = createPhoneTools({ service }).find((d) => d.name === 'phone_screenshot')!
  const value = (await noService.execute({}, {} as never)) as any
  assert.equal(value.ok, true)
  assert.equal(value.image, undefined)
  assert.equal(value.fallback.bytes, 7)
  assert.match(value.message, /无法作为图片/)

  const failing = makeAttachments({ fail: true })
  const withFailing = createPhoneTools({ service, attachments: () => failing }).find(
    (d) => d.name === 'phone_screenshot',
  )!
  const fallbackValue = (await withFailing.execute({}, {} as never)) as any
  assert.equal(fallbackValue.ok, true)
  assert.equal(fallbackValue.image, undefined)
})

test('registerPhoneTools：每个工具一条 effect，卸载后全部移除', () => {
  const host = makeToolHost()
  registerPhoneTools(host, { service: makeService() })
  assert.equal(host.effects, 9)
  assert.deepEqual(host.names, [...PHONE_TOOL_NAMES])
  host.disposeAll()
  assert.deepEqual(host.names, [])
})