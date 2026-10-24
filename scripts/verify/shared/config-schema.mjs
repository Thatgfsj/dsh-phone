/**
 * verify-install 的配置 schema 断言（独立文件，避免 verify-install 超过 300 行目标）。
 *
 * 断言 dump-config-schema 里 dsh-phone entry 的 config schema：顶层字段、attach 三叶与
 * onboarding 两叶 volatile、stream/lifecycle/limits 默认值、runtime 四枚举、x-cordis.complete。
 */
import { assert, assertDeepEqual, assertEqual, assertIncludes, assertMatch, evidence } from './harness.mjs'

const SPEC_CONFIG_KEYS = ['enabled', 'runtime', 'onboarding', 'attach', 'redroid', 'emulator', 'stream', 'lifecycle', 'limits']

export function firstObjectSchema(branch) {
  const candidates = Array.isArray(branch?.anyOf) ? branch.anyOf : []
  return candidates.find((candidate) => candidate?.type?.includes?.('object') && candidate.properties !== undefined)
}

/** 从 dump-config-schema 中提取 dsh-phone 的 config schema。 */
export function extractPhoneConfigSchema(schema) {
  const entry = schema?.$defs?.entry
  assert(entry !== undefined, 'schema 缺少 $defs.entry')
  const branch = (entry.allOf ?? []).find((item) => item?.if?.properties?.name?.const === 'dsh-phone')
  assert(branch !== undefined, 'schema 中找不到 name=dsh-phone 的 entry 分支')
  const ref = branch?.then?.properties?.config?.anyOf?.[0]?.$ref
  assertMatch(ref, /^#\/\$defs\/config\d+$/, 'dsh-phone config ref 格式')
  const definition = schema.$defs[ref.split('/').pop()]
  assert(definition !== undefined, 'schema 缺少 ' + ref + ' 定义')
  const config = firstObjectSchema(definition)
  assert(config !== undefined, 'dsh-phone config schema 没有 object 分支')
  return config
}

export function assertSchema(schema) {
  assertEqual(schema['x-cordis']?.complete, true, 'schema 必须 complete=true')
  const errors = (schema['x-cordis']?.diagnostics ?? []).filter((diagnostic) => diagnostic.level === 'error')
  assertEqual(errors.length, 0, 'schema 存在 error 诊断: ' + JSON.stringify(errors))
  const phone = extractPhoneConfigSchema(schema)
  assertDeepEqual(Object.keys(phone.properties).sort(), [...SPEC_CONFIG_KEYS].sort(), 'dsh-phone config 顶层字段')
  const attach = firstObjectSchema(phone.properties.attach)
  assertDeepEqual(Object.keys(attach.properties).sort(), ['endpoint', 'resolved', 'userHint'], 'attach 字段')
  for (const leaf of ['endpoint', 'userHint', 'resolved']) {
    assertEqual(attach.properties[leaf]['x-cordis']?.volatile, true, 'attach.' + leaf + ' 必须是 volatile')
  }
  // issue #30：首次使用守卫（status/choice 两个 volatile 叶子，默认 pending / ''）
  const onboarding = firstObjectSchema(phone.properties.onboarding)
  assertDeepEqual(Object.keys(onboarding.properties).sort(), ['choice', 'status'], 'onboarding 字段')
  assertEqual(onboarding.properties.status.default, 'pending', 'onboarding.status 默认值')
  assertEqual(onboarding.properties.choice.default, '', 'onboarding.choice 默认值')
  for (const leaf of ['status', 'choice']) {
    assertEqual(onboarding.properties[leaf]['x-cordis']?.volatile, true, 'onboarding.' + leaf + ' 必须是 volatile')
  }
  const stream = firstObjectSchema(phone.properties.stream)
  assertEqual(stream.properties.maxSize.default, 720, 'stream.maxSize 默认值')
  assertEqual(stream.properties.maxFps.default, 15, 'stream.maxFps 默认值')
  assertEqual(stream.properties.bitrate.default, 2000000, 'stream.bitrate 默认值')
  const lifecycle = firstObjectSchema(phone.properties.lifecycle)
  assertEqual(lifecycle.properties.idleTimeoutMs.default, 300000, 'lifecycle.idleTimeoutMs 默认值')
  assertEqual(lifecycle.properties.pausedTimeoutMs.default, 1800000, 'lifecycle.pausedTimeoutMs 默认值')
  assertEqual(firstObjectSchema(phone.properties.limits).properties.maxInstances.default, 1, 'limits.maxInstances')
  assertEqual(phone.properties.enabled.default, true, 'enabled 默认值')
  const runtimeText = JSON.stringify(phone.properties.runtime).replace(/\s+/g, '')
  for (const value of ['auto', 'redroid', 'emulator', 'attach']) {
    assertIncludes(runtimeText, '"const":"' + value + '"', 'runtime 枚举缺少 ' + value)
  }
  evidence(
    'schema',
    'complete=true, attach.*/onboarding.* volatile, stream/lifecycle/limits 默认值, runtime 4 枚举',
  )
}