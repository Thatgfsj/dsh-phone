/**
 * dsh-phone 配置 schema（SPEC §6.1 全量字段与默认值）。
 *
 * 约定（docs/calibration.md §2）：
 * - 只有 `attach.endpoint / attach.userHint / attach.resolved` 是 `.volatile()`：
 *   它们是设置页/接入助手实时写入的叶子，写入经 `ctx.settings.mutate`，不重跑 apply。
 * - `enabled` **不是** volatile：插件总开关只能由用户通过 Loader/配置重载变更，
 *   重载后 `apply` 重新执行以决定是否注册 9 个工具（禁止 Agent 自行改开关）。
 * - `runtime` 也不是 volatile：运行策略属用户，Agent 不得自行改（SPEC §6.4）。
 */
import z from '@deepseek-ai/schemastery'

/** runtime 取值（SPEC §6.1）。 */
export const RUNTIME_VALUES = ['auto', 'redroid', 'emulator', 'attach'] as const

/** 首次使用守卫（issue #30）：status/choice 都是 volatile，用户答复后实时生效。 */
export const ONBOARDING_STATUS_VALUES = ['pending', 'accepted', 'declined'] as const
export const ONBOARDING_CHOICE_VALUES = ['', 'emulator', 'redroid', 'attach'] as const

/** 平台三运行时的默认安装/启动参数（SPEC §6.1，全部为普通配置字段）。 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('插件总开关；变更权仅属用户，Agent 不得自行修改'),
  runtime: z
    .union([
      z.const('auto'),
      z.const('redroid'),
      z.const('emulator'),
      z.const('attach'),
    ])
    .default('auto')
    .description('运行时策略：auto 按 SPEC §3.1 决策树选择'),
  onboarding: z
    .object({
      status: z
        .union([z.const('pending'), z.const('accepted'), z.const('declined')])
        .default('pending')
        .volatile()
        .description('首次使用守卫：用户明确同意前不碰设备（pending/accepted/declined）'),
      choice: z
        .union([z.const(''), z.const('emulator'), z.const('redroid'), z.const('attach')])
        .default('')
        .volatile()
        .description('用户选择的接入方式；accepted 且非空时等价显式 runtime'),
    })
    .default({ status: 'pending', choice: '' }),
  attach: z
    .object({
      endpoint: z
        .string()
        .default('')
        .volatile()
        .description('已解析的 adb TCP 端点，如 127.0.0.1:5555'),
      userHint: z
        .string()
        .default('')
        .volatile()
        .description('用户的一句话（原文永久保留，SPEC §6.2 R2）'),
      resolved: z
        .boolean()
        .default(false)
        .volatile()
        .description('接入解析完成哨兵（缓存锚点，SPEC §6.2 R3）'),
    })
    .default({ endpoint: '', userHint: '', resolved: false }),
  redroid: z
    .object({
      image: z.string().default('redroid/redroid:14-latest'),
      memLimit: z.string().default('2g'),
      vcpuLimit: z.number().default(2),
    })
    .default({ image: 'redroid/redroid:14-latest', memLimit: '2g', vcpuLimit: 2 }),
  emulator: z
    .object({
      avdName: z.string().default(''),
      resolution: z.string().default('720x1280'),
    })
    .default({ avdName: '', resolution: '720x1280' }),
  stream: z
    .object({
      maxSize: z.number().default(720),
      maxFps: z.number().default(15),
      bitrate: z.number().default(2000000),
    })
    .default({ maxSize: 720, maxFps: 15, bitrate: 2000000 }),
  lifecycle: z
    .object({
      idleTimeoutMs: z.number().default(300000),
      pausedTimeoutMs: z.number().default(1800000),
    })
    .default({ idleTimeoutMs: 300000, pausedTimeoutMs: 1800000 }),
  limits: z
    .object({
      maxInstances: z.number().default(1),
    })
    .default({ maxInstances: 1 }),
})

/** 校验后的配置类型（volatile 叶子在运行时是 `{ get(): T }`）。 */
export type PhoneConfig = ReturnType<typeof Config>

/** 配置命名空间 = profile 行 id（package.json name）。 */
export const CONFIG_NS = 'dsh-phone'

/** 可被设置页/接入助手/首次使用守卫实时写入的 volatile 路径（SPEC §6.2 R1 + issue #30）。 */
export const WRITABLE_CONFIG_PATHS = [
  ['attach', 'userHint'],
  ['attach', 'endpoint'],
  ['attach', 'resolved'],
  ['onboarding', 'status'],
  ['onboarding', 'choice'],
] as const