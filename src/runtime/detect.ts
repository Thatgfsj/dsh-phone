/**
 * 运行时决策树（SPEC §3.1，禁止跳步）：
 *
 * ```
 * 1. Docker 可用 且 平台=Linux 且 /dev/binder 存在  → redroid
 * 2. emulator 可用 且 虚拟化可用（KVM/WHPX/HVF）    → emulator
 * 3. 配置了 attach.endpoint（或 userHint 待解析）   → attach
 * 4. 全失败 → 抛带平台安装指引的错误（禁止静默失败）
 * ```
 *
 * 返回首个可用适配器与完整原因链（`steps`），便于 status/日志解释“为什么选它”。
 */

import { AttachRuntime } from './attach.ts'
import { installGuideHints } from './install-guide.ts'
import { EmulatorRuntime } from './emulator.ts'
import { RedroidRuntime } from './redroid.ts'
import {
  RuntimeUnavailableError,
  formatEndpoint,
  parseEndpoint,
} from './types.ts'
export {
  installGuide,
  installGuideData,
  installGuideHints,
  sdkmanagerPath,
} from './install-guide.ts'

import type {
  DetectionStep,
  Platform,
  RuntimeAdapter,
  RuntimeDeps,
  RuntimeDetection,
  RuntimeEnvironment,
  RuntimeKind,
  RuntimeOptions,
} from './types.ts'

/** 主机上是否存在可用且已授权的 emulator（供 status 显示，不改变决策）。 */
export function createRuntimeAdapter(
  kind: RuntimeKind,
  options: RuntimeOptions,
  deps: RuntimeDeps,
): RuntimeAdapter {
  switch (kind) {
    case 'redroid':
      return new RedroidRuntime({ redroid: options.redroid, deps })
    case 'emulator':
      return new EmulatorRuntime({ emulator: options.emulator, deps })
    case 'attach':
      return new AttachRuntime({ attach: options.attach, env: deps.env })
  }
}

/**
 * 按 SPEC §3.1 决策树选择运行时。全失败时抛
 * {@link RuntimeUnavailableError}（message 含平台安装指引）。
 */
export async function detectRuntime(
  options: RuntimeOptions,
  env: RuntimeEnvironment,
): Promise<RuntimeDetection> {
  const steps: DetectionStep[] = []
  const platform = await env.platform()

  if (options.runtime !== 'auto') {
    steps.push({
      step: options.runtime,
      ok: true,
      detail: `runtime=${options.runtime}（显式配置，不走自动决策树）`,
    })
    return {
      kind: options.runtime,
      platform,
      steps,
      reason: steps[0]!.detail,
    }
  }

  // 1. redroid：Docker 可用 且 Linux 且 /dev/binder
  const hasDocker = await env.hasCommand('docker')
  if (!hasDocker) {
    steps.push({ step: 'redroid', ok: false, detail: '未找到 docker CLI' })
  } else if (platform !== 'linux') {
    steps.push({
      step: 'redroid',
      ok: false,
      detail: `平台为 ${platform}，redroid 仅支持 Linux`,
    })
  } else if (!(await env.pathExists('/dev/binder'))) {
    steps.push({
      step: 'redroid',
      ok: false,
      detail: '缺少 /dev/binder（binder_linux 模块未加载）',
    })
  } else {
    const detail = `docker 可用、平台 Linux、/dev/binder 存在 → redroid（镜像 ${options.redroid.image}）`
    steps.push({ step: 'redroid', ok: true, detail })
    return { kind: 'redroid', platform, steps, reason: detail }
  }

  // 2. emulator：可执行文件存在 且 虚拟化可用（KVM / WHPX / HVF）
  const emulatorPath = await env.findEmulator()
  if (!emulatorPath) {
    steps.push({
      step: 'emulator',
      ok: false,
      detail: '未找到 Android SDK emulator 可执行文件',
    })
  } else {
    const acceleration = await env.acceleration(platform, emulatorPath)
    if (acceleration.ok) {
      const detail = `emulator=${emulatorPath}；${acceleration.detail ?? '硬件虚拟化可用'}`
      steps.push({ step: 'emulator', ok: true, detail })
      return { kind: 'emulator', platform, steps, reason: detail }
    }
    steps.push({
      step: 'emulator',
      ok: false,
      detail: `emulator=${emulatorPath}，但${acceleration.reason ?? '硬件虚拟化不可用'}`,
    })
  }

  // 3. attach：已解析 endpoint，或 userHint 待宿主接入流程解析
  const endpoint = parseEndpoint(options.attach.endpoint)
  const userHint = options.attach.userHint.trim()
  if (endpoint) {
    const detail = `attach.endpoint=${formatEndpoint(endpoint)}`
    steps.push({ step: 'attach', ok: true, detail })
    return { kind: 'attach', platform, steps, reason: detail }
  }
  if (userHint) {
    const detail = 'attach.userHint 待解析（由宿主接入流程写入 attach.endpoint）'
    steps.push({ step: 'attach', ok: true, detail })
    return { kind: 'attach', platform, steps, reason: detail }
  }
  steps.push({
    step: 'attach',
    ok: false,
    detail: '未配置 attach.endpoint，也没有待解析的 attach.userHint',
  })

  // 4. 全失败：给平台指引，禁止静默失败
  steps.push({ step: 'fail', ok: false, detail: '三条路径均不可用' })
  const hints = [
    ...steps.map((step) => `- ${step.step}: ${step.detail}`),
    '',
    ...installGuideHints(platform),
  ]
  throw new RuntimeUnavailableError(preferredRuntime(platform), hints, undefined, {
    platform,
    steps,
  })
}

/** 平台的首选运行时（SPEC §3.1 表格）：仅用于全失败时的错误语义。 */
export function preferredRuntime(platform: Platform): RuntimeKind {
  if (platform === 'linux') return 'redroid'
  if (platform === 'windows' || platform === 'macos') return 'emulator'
  return 'attach'
}

/** 探测 + 创建适配器的一步式入口（宿主层用）。 */
export async function resolveRuntime(
  options: RuntimeOptions,
  deps: RuntimeDeps,
): Promise<{ adapter: RuntimeAdapter; detection: RuntimeDetection }> {
  const detection = await detectRuntime(options, deps.env)
  return { adapter: createRuntimeAdapter(detection.kind, options, deps), detection }
}
