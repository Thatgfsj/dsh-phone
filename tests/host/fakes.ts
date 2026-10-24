/** Host 单测的假实现：不依赖 runtime/stream/真机。 */
import type {
  AttachmentsLike,
  InteractiveReadiness,
  PhoneOperations,
  PhoneStatus,
  VerifyResult,
} from '../../src/phone/contracts.ts'

export interface FakeService extends PhoneOperations {
  calls: string[]
  /** 下一次 ensureInteractive 的返回值（默认 running）。 */
  setReadiness(readiness: InteractiveReadiness | Error): void
  /** 让指定方法抛错（模拟 ADB/runtime 失败）。 */
  failOn(method: keyof PhoneOperations, error: unknown): void
}

export function makeStatus(overrides: Partial<PhoneStatus> = {}): PhoneStatus {
  return {
    state: 'running',
    runtime: 'attach',
    platform: 'linux',
    ...overrides,
  }
}

export function makeService(overrides: Partial<PhoneOperations> = {}): FakeService {
  const calls: string[] = []
  let readiness: InteractiveReadiness | Error = { state: 'running' }
  const failures = new Map<string, unknown>()

  const call = async <T>(name: string, value: T): Promise<T> => {
    calls.push(name)
    if (failures.has(name)) throw failures.get(name)
    return value
  }

  const service: FakeService = {
    calls,
    setReadiness(next) {
      readiness = next
    },
    failOn(method, error) {
      failures.set(method, error)
    },
    status: () => call('status', makeStatus()) as Promise<PhoneStatus>,
    ensureRunning: async () => {
      calls.push('ensureRunning')
      if (failures.has('ensureRunning')) throw failures.get('ensureRunning')
    },
    ensureInteractive: async () => {
      calls.push('ensureInteractive')
      if (failures.has('ensureInteractive')) throw failures.get('ensureInteractive')
      if (readiness instanceof Error) throw readiness
      return readiness
    },
    screenshot: () => call('screenshot', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
    tap: async (x, y) => {
      await call('tap:' + x + ',' + y, undefined)
    },
    swipe: async (x1, y1, x2, y2, durationMs) => {
      await call('swipe:' + x1 + ',' + y1 + '>' + x2 + ',' + y2 + '@' + durationMs, undefined)
    },
    key: async (name) => {
      await call('key:' + name, undefined)
    },
    inputText: async (text) => {
      await call('inputText:' + text, undefined)
    },
    appLaunch: async (pkg) => {
      await call('appLaunch:' + pkg, undefined)
    },
    dumpUi: () => call('dumpUi', '<hierarchy><node bounds="[0,0][720,1280]"/></hierarchy>'),
    shell: (command) => call('shell:' + command, 'model=TestPhone'),
    touchScreen: async (action, x, y) => {
      await call('touch:' + action + ':' + x + ',' + y, undefined)
    },
    verifyEndpoint: () => call('verifyEndpoint', { ok: true, latencyMs: 3 } as VerifyResult),
    ...overrides,
  }
  return service
}

export function makeAttachments(options: { fail?: boolean } = {}): AttachmentsLike & { saved: number } {
  const state = { saved: 0, fail: options.fail === true } as AttachmentsLike & {
    saved: number
    fail: boolean
  }
  state.saved = 0
  state.saveImage = async () => {
    if (state.fail) throw new Error('attachment backend unavailable')
    state.saved += 1
    return {
      attachmentId: 'att-' + state.saved,
      mediaType: 'image/png' as const,
      bytes: 7,
      width: 720,
      height: 1280,
      name: 'phone-screenshot.png',
    }
  }
  return state
}

/** 假的 cordis host：收集注册与 effect，便于断言回收。 */
export interface FakeToolHost {
  names: string[]
  effects: number
  disposeAll(): void
  tools: { register(definition: { name: string }): () => void }
  effect(callback: () => (() => void) | void): void
}

export function makeToolHost(): FakeToolHost {
  const disposers: (() => void)[] = []
  const host: FakeToolHost = {
    names: [],
    effects: 0,
    disposeAll() {
      while (disposers.length > 0) disposers.pop()!()
    },
    tools: {
      register(definition) {
        host.names.push(definition.name)
        const dispose = () => {
          const index = host.names.indexOf(definition.name)
          if (index >= 0) host.names.splice(index, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
    effect(callback) {
      host.effects += 1
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  return host
}