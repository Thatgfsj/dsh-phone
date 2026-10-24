/**
 * 首次使用守卫（onboarding，issue #30）。
 *
 * 用户**明确答复**启用插件并选择/完成接入方式之前，9 个 phone_* 工具一律不碰设备：
 * 返回结构化 `E_ONBOARDING_REQUIRED`，由操作 Agent 向用户提问；declined 返回
 * `E_ONBOARDING_DECLINED`。插件自身**不安装任何软件、不启动运行时、不写配置**（SPEC §6.4）。
 *
 * 状态存放在 `dsh-phone.onboarding`（两个 volatile 叶子）：
 * - `status: 'pending' | 'accepted' | 'declined'`（默认 pending）
 * - `choice: '' | 'emulator' | 'redroid' | 'attach'`（默认 ''）
 * 旧配置没有该段时由 schema 默认值补齐为 pending（升级后首次仍会询问）。
 */
import { createOnboardingInstallPayload } from '../runtime/install-guide.ts'
import type { OnboardingInstallCommands } from '../runtime/install-guide.ts'
import type { RuntimeSetting } from '../runtime/types.ts'

export const ONBOARDING_STATUS_VALUES = ['pending', 'accepted', 'declined'] as const
export const ONBOARDING_CHOICE_VALUES = ['', 'emulator', 'redroid', 'attach'] as const

export type OnboardingStatus = (typeof ONBOARDING_STATUS_VALUES)[number]
export type OnboardingChoice = (typeof ONBOARDING_CHOICE_VALUES)[number]

export interface OnboardingState {
  status: OnboardingStatus
  choice: OnboardingChoice
}

/** 与 DSH 工具输出 schema 的 json 值同构（递归 JSON）。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export const DEFAULT_ONBOARDING_STATE: OnboardingState = { status: 'pending', choice: '' }

/** 工具返回里的文档锚点（docs/usage.md 的「首次使用」小节）。 */
export const ONBOARDING_DOCS = 'docs/usage.md#首次使用'

export const ONBOARDING_QUESTION =
  '首次使用「肥鱼的手机」：是否启用 Android 实例？请选择接入方式（会按需下载/启动，插件不会替你安装软件）。'

export interface OnboardingOption {
  id: 'emulator' | 'redroid' | 'attach' | 'decline'
  label: string
  description: string
}

export const ONBOARDING_OPTIONS: readonly OnboardingOption[] = [
  {
    id: 'emulator',
    label: 'Android SDK Emulator（推荐，Windows/macOS/Linux）',
    description: '需要 Android SDK Emulator 与硬件虚拟化；首次启动约 20–40s。',
  },
  {
    id: 'redroid',
    label: 'redroid（Linux + Docker）',
    description: '容器化 Android，需要 Docker 与 binder_linux 模块；冷启动约 8–15s。',
  },
  {
    id: 'attach',
    label: '连接已有模拟器/真机',
    description: '用户已有的实例（雷电/夜神/MuMu/AVD/真机），需要提供 adb TCP 端点。',
  },
  {
    id: 'decline',
    label: '暂不使用',
    description: '不启用手机；之后可在插件设置页重新开启。',
  },
]

/** install 载荷形状（数据源：src/runtime/install-guide.ts）。 */
export type OnboardingInstallGuide = OnboardingInstallCommands

/**
 * 安装命令由 src/runtime/install-guide.ts 统一提供（issue #38：detect 提示 /
 * onboarding 载荷 / 客户端卡片共用同一数据源，避免文案漂移）。只展示、不执行（SPEC 6.4）。
 */
export const ONBOARDING_INSTALL: OnboardingInstallGuide = createOnboardingInstallPayload()

export interface OnboardingPayload {
  step: 'consent' | 'choose-runtime'
  question: string
  options: readonly OnboardingOption[]
  install: OnboardingInstallGuide
  docs: string
}

/** 工具层的守卫失败结构（9 个工具共用）。 */
export interface OnboardingToolFailure {
  ok: false
  code: 'E_ONBOARDING_REQUIRED' | 'E_ONBOARDING_DECLINED'
  message: string
  retryable: false
  onboarding?: JsonValue
}

export function isOnboardingStatus(value: unknown): value is OnboardingStatus {
  return typeof value === 'string' && (ONBOARDING_STATUS_VALUES as readonly string[]).includes(value)
}

export function isOnboardingChoice(value: unknown): value is OnboardingChoice {
  return typeof value === 'string' && (ONBOARDING_CHOICE_VALUES as readonly string[]).includes(value)
}

/** 从未知配置值构造状态（非法值回落默认；旧配置无该段 → pending）。 */
export function normalizeOnboardingState(value: unknown): OnboardingState {
  if (value === null || typeof value !== 'object') return { ...DEFAULT_ONBOARDING_STATE }
  const record = value as Record<string, unknown>
  return {
    status: isOnboardingStatus(record.status) ? record.status : 'pending',
    choice: isOnboardingChoice(record.choice) ? record.choice : '',
  }
}

/**
 * 工具守卫：accepted 返回 undefined（放行）；pending/declined 返回结构化拒绝。
 * **不触碰 runtime/ADB/配置**。
 */
export function onboardingFailure(state: OnboardingState): OnboardingToolFailure | undefined {
  if (state.status === 'accepted') return undefined
  if (state.status === 'declined') {
    return {
      ok: false,
      code: 'E_ONBOARDING_DECLINED',
      message: '用户已选择暂不使用「肥鱼的手机」；可在插件设置页重新启用（无需重启 DSH）。',
      retryable: false,
    }
  }
  return {
    ok: false,
    code: 'E_ONBOARDING_REQUIRED',
    message: ONBOARDING_QUESTION,
    retryable: false,
    onboarding: {
      step: state.choice === '' ? 'consent' : 'choose-runtime',
      question: ONBOARDING_QUESTION,
      options: ONBOARDING_OPTIONS,
      install: ONBOARDING_INSTALL,
      docs: ONBOARDING_DOCS,
    } as unknown as JsonValue,
  }
}

/**
 * 显式运行时覆盖：accepted 且 choice 非空 → 等价 `runtime=choice`（只走该 kind，
 * 跳过 auto 决策树）；否则沿用原 `runtime` 配置（auto 或显式）。
 */
export function effectiveRuntime(configured: RuntimeSetting, state: OnboardingState): RuntimeSetting {
  if (state.status === 'accepted' && state.choice !== '') return state.choice
  return configured
}