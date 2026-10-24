/**
 * Host 装配：把 runtime（detect/adb）、stream 与 PhoneService 接起来。
 *
 * 只 import `../stream/index.ts`（stream PR #13 冻结的唯一入口）：
 * - `startStream(adb, options, sink, extra?)`：视频会话（extra.video=false 等价 control-only）；
 * - `startControlOnly(adb, options)`：无 viewer 时给 phone_input_text/touch 提供控制通道；
 * - `createStreamUpgradeRoute(deps)`：/dsh-phone/stream 的 WS 升级处理器。
 *
 * runtime 模块（PR #15 已合并）提供 resolveRuntime/PhoneLifecycle/AdbDevice/connect。
 */
import { AdbDevice } from '../adb/device.ts'
import { connect, disconnect } from '../adb/transport.ts'
import type { AdbConnection } from '../adb/types.ts'
import { effectiveRuntime } from '../config/onboarding.ts'
import type { OnboardingState } from '../config/onboarding.ts'
import type { PhoneConfig } from '../config/schema.ts'
import { createCommandRunner } from '../runtime/command.ts'
import { resolveRuntime } from '../runtime/detect.ts'
import type { RuntimeOptions } from '../runtime/types.ts'
import { createSystemEnvironment, detectPlatform } from '../runtime/probe.ts'
import type { StreamHandle } from '../stream/index.ts'
import { startControlOnly, startStream } from '../stream/index.ts'
import type { ServiceConfig, StreamSession, StreamSessionOptions } from './service.ts'
import { PhoneLifecycle } from './state.ts'
import { PhoneService } from './service.ts'

/** 实时读取 onboarding 状态（两个 volatile 叶子）。 */
export function readOnboarding(config: PhoneConfig): OnboardingState {
  return { status: config.onboarding.status.get(), choice: config.onboarding.choice.get() }
}

/**
 * 把 volatile 配置（.get()）实时投影成 PhoneService 读的纯值快照。
 * onboarding accepted + choice 非空时，等价显式 `runtime=choice`（issue #30）。
 */
export function readServiceConfig(config: PhoneConfig): ServiceConfig {
  const onboarding = readOnboarding(config)
  return {
    runtime: effectiveRuntime(config.runtime, onboarding),
    attach: {
      endpoint: config.attach.endpoint.get(),
      userHint: config.attach.userHint.get(),
      resolved: config.attach.resolved.get(),
    },
    stream: {
      maxSize: config.stream.maxSize,
      maxFps: config.stream.maxFps,
      bitrate: config.stream.bitrate,
    },
    lifecycle: {
      idleTimeoutMs: config.lifecycle.idleTimeoutMs,
      pausedTimeoutMs: config.lifecycle.pausedTimeoutMs,
    },
  }
}

function runtimeOptions(config: PhoneConfig): RuntimeOptions {
  const service = readServiceConfig(config)
  return {
    runtime: service.runtime,
    redroid: {
      image: config.redroid.image,
      memLimit: config.redroid.memLimit,
      vcpuLimit: config.redroid.vcpuLimit,
    },
    emulator: {
      avdName: config.emulator.avdName,
      resolution: config.emulator.resolution,
    },
    attach: service.attach,
  }
}

/** StreamHandle（stream 层）→ PhoneService 用的窄会话。 */
function adaptHandle(handle: StreamHandle): StreamSession {
  return {
    ready: handle.info,
    injectText: (text) => handle.controller.injectText(text),
    injectTouch: (action, x, y) => handle.controller.injectTouch(action, x, y),
    injectKey: (name) => handle.controller.injectKey(name),
    close: () => handle.stop(),
  }
}

/** 创建 Host 侧 PhoneService（真实依赖；单测不经过本函数）。 */
export function createPhoneService(config: PhoneConfig): PhoneService {
  const env = createSystemEnvironment()
  const runner = createCommandRunner()
  return new PhoneService({
    config: () => readServiceConfig(config),
    resolveRuntime: async () => {
      const { adapter, detection } = await resolveRuntime(runtimeOptions(config), { env, runner })
      return { adapter, detection: { kind: detection.kind, platform: detection.platform } }
    },
    platform: async () => detectPlatform(),
    connect: (endpoint, options) => connect(endpoint, options),
    disconnect: (connection) => disconnect(connection as AdbConnection),
    createDevice: (connection) => new AdbDevice(connection as AdbConnection),
    startStream: async (options: StreamSessionOptions): Promise<StreamSession> => {
      const adb = options.adb as AdbConnection
      const handle = options.video
        ? await startStream(adb, options.config, options.sink ?? { video: () => {}, error: () => {} })
        : await startControlOnly(adb, options.config)
      return adaptHandle(handle)
    },
    createLifecycle: (hooks, timings) => new PhoneLifecycle(hooks, timings),
  })
}