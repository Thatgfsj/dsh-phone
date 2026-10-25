#!/usr/bin/env node
/**
 * verify-tools：用假 ctx 加载 src/index.ts 的 apply，验收工具注册与 phone_shell 审批。
 *
 * 覆盖（对应 issue #8 / docs/verification.md）：
 * 1. 插件元数据：name=dsh-phone、inject 含 tools；
 * 2. apply 注册 9 个 phone_* 工具，名称/顺序与 SPEC §4 完全一致；
 * 3. 每个工具的参数 schema（required/type）与 SPEC §4 一致；
 * 4. 描述包含关键使用纪律（status 第一步、坐标来自截图/控件树、中文走 INJECT_TEXT、shell 白名单+审批）；
 * 5. tools/pre-execute 审批 handler 存在：非白名单 → {kind:'ask'}，白名单 → next() 放行；
 * 6. enabled=false → 不注册工具、不注册审批，只保留设置页只读路由（经 inject 记录验证）。
 *
 * 不依赖真机 / Docker / emulator / 浏览器；纯进程内假 ctx。
 */
import { apply, inject, name as pluginName } from '../../src/index.ts'
import {
  Cleanup,
  assert,
  assertDeepEqual,
  assertEqual,
  assertIncludes,
  evidence,
  runScript,
  step,
} from './shared/harness.mjs'

const SPEC_TOOLS = [
  'phone_status',
  'phone_screenshot',
  'phone_tap',
  'phone_swipe',
  'phone_key',
  'phone_input_text',
  'phone_app_launch',
  'phone_uiautomator_dump',
  'phone_shell',
]

/** SPEC §4 参数契约：工具名 → { 必填, 参数类型 }。 */
const SPEC_PARAMS = {
  phone_status: { required: [], types: {} },
  phone_screenshot: { required: [], types: {} },
  phone_tap: { required: ['x', 'y'], types: { x: 'integer', y: 'integer' } },
  phone_swipe: {
    required: ['x1', 'y1', 'x2', 'y2', 'durationMs'],
    types: { x1: 'integer', y1: 'integer', x2: 'integer', y2: 'integer', durationMs: 'integer' },
  },
  phone_key: { required: ['name'], types: { name: 'string' } },
  phone_input_text: { required: ['text'], types: { text: 'string' } },
  phone_app_launch: { required: ['pkg'], types: { pkg: 'string' } },
  phone_uiautomator_dump: { required: [], types: {} },
  phone_shell: { required: ['cmd'], types: { cmd: 'string' } },
}

/** 单测同款假 config：volatile 叶子用 { get() }（与 Schemastery 运行时一致）。 */
function makeConfig(overrides = {}) {
  const leaf = (value) => ({ get: () => value })
  return {
    enabled: true,
    runtime: 'auto',
    attach: { endpoint: leaf(''), userHint: leaf(''), resolved: leaf(false) },
    redroid: { image: 'redroid/redroid:14-latest', memLimit: '2g', vcpuLimit: 2 },
    emulator: { avdName: '', resolution: '720x1280' },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2000000 },
    lifecycle: { idleTimeoutMs: 300000, pausedTimeoutMs: 1800000 },
    limits: { maxInstances: 1 },
    ...overrides,
  }
}

/** 假 cordis ctx：记录工具注册/effect/inject/on，卸载时按 LIFO 回收。 */
function makeCtx() {
  const definitions = []
  const effects = []
  const injectCalls = []
  const listeners = []
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition)
        const dispose = () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      effects.push(dispose)
    },
    get() {
      return undefined
    },
    on(event, listener) {
      assertEqual(event, 'tools/pre-execute', '只允许注册 tools/pre-execute')
      listeners.push(listener)
      return () => {}
    },
    inject(dependencies, callback) {
      injectCalls.push({ dependencies, callback })
    },
    disposeAll() {
      while (disposers.length > 0) disposers.pop()()
    },
  }
  return { ctx, definitions, effects, injectCalls, listeners, disposers }
}

const cleanup = new Cleanup()

await runScript(async () => {
  await step('插件元数据：name / inject', () => {
    assertEqual(pluginName, 'dsh-phone', '插件 name 必须是 dsh-phone')
    assertDeepEqual(inject, ['tools'], 'inject 必须包含 tools（硬依赖）')
  })

  const fake = makeCtx()
  await step('apply：注册 9 个 phone_* 工具', () => {
    apply(fake.ctx, makeConfig())
    assertEqual(fake.definitions.length, 9, '工具数量必须是 9')
    assertDeepEqual(
      fake.definitions.map((definition) => definition.name),
      SPEC_TOOLS,
      '工具名称/顺序必须与 SPEC §4 一致',
    )
    assertEqual(fake.listeners.length, 1, '必须注册恰好 1 条 tools/pre-execute 审批 handler')
    // #65 起多 1 个 Provisioner dispose effect
    assertEqual(
      fake.effects.length,
      11,
      '1 个 PhoneService effect + 1 个 Provisioner effect + 9 个工具 effect',
    )
    evidence('registered tools', fake.definitions.map((definition) => definition.name).join(', '))
  })

  await step('参数 schema 与 SPEC §4 一致', () => {
    for (const definition of fake.definitions) {
      const expected = SPEC_PARAMS[definition.name]
      assert(expected !== undefined, '未知工具 ' + definition.name)
      const parameters = definition.parameters
      assertEqual(parameters.type, 'object', definition.name + '.parameters.type')
      const propertyKeys = Object.keys(parameters.properties ?? {}).sort()
      assertDeepEqual(propertyKeys, Object.keys(expected.types).sort(), definition.name + ' 参数集合')
      const required = [...(parameters.required ?? [])].sort()
      assertDeepEqual(required, [...expected.required].sort(), definition.name + ' 必填参数')
      for (const [key, type] of Object.entries(expected.types)) {
        assertEqual(parameters.properties[key].type, type, definition.name + '.' + key + ' 类型')
      }
      assert(typeof definition.description === 'string' && definition.description.length > 0, definition.name + ' 缺少描述')
      assert(definition.output?.schema !== undefined, definition.name + ' 缺少 output.schema')
      assertEqual(typeof definition.output?.render, 'function', definition.name + ' 缺少 output.render')
    }
  })

  await step('工具描述包含 SPEC 使用纪律', () => {
    const descriptions = new Map(fake.definitions.map((definition) => [definition.name, definition.description]))
    assertIncludes(descriptions.get('phone_status'), '第一步', 'phone_status 必须提示“第一步必调”')
    assertMatchAny(descriptions.get('phone_tap'), [/截图/, /控件树/], 'phone_tap 必须要求坐标来自截图/控件树')
    assertMatchAny(descriptions.get('phone_swipe'), [/截图/, /控件树/], 'phone_swipe 必须要求坐标来自截图/控件树')
    assertIncludes(descriptions.get('phone_input_text'), '中文', 'phone_input_text 必须说明中文支持')
    assertMatchAny(descriptions.get('phone_input_text'), [/INJECT_TEXT/, /scrcpy/], 'phone_input_text 必须走 INJECT_TEXT/scrcpy')
    assertMatchAny(descriptions.get('phone_shell'), [/白名单/], 'phone_shell 必须说明白名单')
    assertMatchAny(descriptions.get('phone_shell'), [/审批/, /ask/], 'phone_shell 必须说明审批')
  })

  await step('phone_shell 审批：非白名单 ask / 白名单放行 / 非本工具 next', async () => {
    const listener = fake.listeners[0]
    const allowed = await listener({ name: 'phone_shell', arguments: { cmd: 'getprop ro.product.model' } }, async () => 'NEXT')
    assertEqual(allowed, 'NEXT', '白名单命令必须 next() 放行')
    const dumpsys = await listener({ name: 'phone_shell', arguments: { cmd: 'dumpsys battery' } }, async () => 'NEXT')
    assertEqual(dumpsys, 'NEXT', 'dumpsys 只读 service 必须放行')

    const decision = await listener({ name: 'phone_shell', arguments: { cmd: 'rm -rf /sdcard/tmp' } }, async () => 'NEXT')
    assertEqual(decision.kind, 'ask', '非白名单命令必须返回 ask')
    assertIncludes(decision.reason, 'rm -rf /sdcard/tmp', 'ask.reason 必须包含将执行的命令')
    assertEqual(typeof decision.displayReason?.en, 'string', 'ask.displayReason.en 必须存在')
    assertEqual(typeof decision.displayReason?.zh, 'string', 'ask.displayReason.zh 必须存在')

    const other = await listener({ name: 'phone_tap', arguments: { x: 1, y: 1 } }, async () => 'NEXT')
    assertEqual(other, 'NEXT', '非 phone_shell 工具必须 next()')
    evidence('phone_shell ask', '非白名单 → ask；getprop/dumpsys → next；其它工具 → next')
    cleanup.register('释放假 ctx', () => fake.ctx.disposeAll())
  })

  await step('卸载：逆序 effect 全部回收，工具清空', () => {
    fake.ctx.disposeAll()
    assertEqual(fake.definitions.length, 0, '卸载后不应残留工具注册')
    assertEqual(fake.listeners.length, 1, '审批 handler 本身由 cordis 回收（本假 ctx 只记录）')
  })

  await step('enabled=false：不注册工具/审批，只保留设置页只读路由', () => {
    const disabled = makeCtx()
    apply(disabled.ctx, makeConfig({ enabled: false }))
    assertEqual(disabled.definitions.length, 0, 'enabled=false 不得注册 phone_* 工具')
    assertEqual(disabled.listeners.length, 0, 'enabled=false 不得注册 phone_shell 审批')
    assertEqual(disabled.injectCalls.length, 1, 'enabled=false 只应注册只读 webServer 路由')
    assertDeepEqual(disabled.injectCalls[0].dependencies, ['webServer'], '只读路由依赖 webServer')
    evidence('enabled=false', 'tools=0, pre-execute=0, inject=[webServer]')
  })
}, cleanup)

/** 断言描述至少匹配其中一个正则（描述文案可微调，语义必须保留）。 */
function assertMatchAny(value, patterns, message) {
  assert(patterns.some((pattern) => pattern.test(String(value))), message)
}