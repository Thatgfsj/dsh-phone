/**
 * 视频会话管理：viewer 引用计数 + startStream 单飞 + 5s 宽限期 + 断开清理。
 *
 * docs/architecture.md §6：第 1 个 viewer 开流，最后一个 release 后宽限 5s 再关
 * （吸收 tab 切换抖动）；只允许一个 scrcpy 会话，多个 viewer 共享同一路码流。
 *
 * 本类导出给 host 的 PhoneService 使用：`addViewer(sink)` 返回 release 函数。
 *
 * issue #73 备注：当前生产 Host 使用自带「viewer 计数 + 代际 + 心跳」实现（因为需要与
 * scrcpy controller/控制通道共享同一 handle）；本类保留为独立引用计数实现与测试夹具，
 * 未被 `src/phone/service.ts` 直接实例化。
 */

import type { StreamHandle, StreamSink } from './types.ts'

/** 宽限期默认值（docs/protocol.md §2.1）。 */
export const DEFAULT_STREAM_GRACE_MS = 5_000

export interface SessionClock {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: SessionClock = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface StreamSessionOptions {
  /** 开流函数（scrcpy.startStream 或测试注入）；只会在引用计数 0→1 时调用。 */
  start: (sink: StreamSink) => Promise<StreamHandle>
  /** 0 viewer 后关流延迟，默认 5000ms。 */
  graceMs?: number
  /** 会话/回调异常上报（默认 console.error，可注入测试）。 */
  onError?: (error: Error) => void
  clock?: SessionClock
}

/**
 * 一个进程内唯一的视频会话。
 *
 * 生命周期：`addViewer` → count 0→1 时 start（单飞）→ 共享 handle；
 * 每个 release 使 count-1；归零后 graceMs 内重新 addViewer 会复用会话。
 */
export class StreamSession {
  #start: (sink: StreamSink) => Promise<StreamHandle>
  #graceMs: number
  #onError: (error: Error) => void
  #clock: SessionClock
  #viewers: StreamSink[] = []
  #handle: StreamHandle | undefined
  #starting: Promise<StreamHandle> | undefined
  #graceTimer: unknown
  #disposed = false

  constructor(options: StreamSessionOptions) {
    this.#start = options.start
    this.#graceMs = options.graceMs ?? DEFAULT_STREAM_GRACE_MS
    this.#onError = options.onError ?? ((error) => console.error('[dsh-phone] stream:', error))
    this.#clock = options.clock ?? systemClock
  }

  get viewerCount(): number {
    return this.#viewers.length
  }

  get running(): boolean {
    return this.#handle !== undefined
  }

  /**
   * 增加一个 viewer 并确保流已启动。
   *
   * 返回幂等的 release 函数；启动失败时 viewer 不会被计入并抛出原始错误。
   */
  async addViewer(sink: StreamSink): Promise<() => Promise<void>> {
    this.#disposed = false
    this.#cancelGrace()
    if (!this.#viewers.includes(sink)) this.#viewers.push(sink)
    try {
      await this.#ensureStarted()
    } catch (error) {
      this.#removeViewer(sink)
      throw error
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      await this.removeViewer(sink)
    }
  }

  async removeViewer(sink: StreamSink): Promise<void> {
    const removed = this.#removeViewer(sink)
    if (!removed) return
    if (this.#viewers.length === 0) this.#scheduleStop()
  }

  /** 立即关流（插件卸载/显式停止）；幂等。 */
  async stopNow(): Promise<void> {
    this.#cancelGrace()
    this.#disposed = true
    this.#viewers = []
    const handle = this.#handle
    this.#handle = undefined
    if (this.#starting) {
      await this.#starting.catch(() => {})
      this.#starting = undefined
    }
    if (handle) await safeStop(handle, this.#onError)
  }

  #removeViewer(sink: StreamSink): boolean {
    const index = this.#viewers.indexOf(sink)
    if (index < 0) return false
    this.#viewers.splice(index, 1)
    return true
  }

  #ensureStarted(): Promise<StreamHandle> {
    if (this.#disposed) {
      return Promise.reject(new Error('视频会话已停止（disposed）'))
    }
    if (this.#handle) return Promise.resolve(this.#handle)
    if (this.#starting) return this.#starting
    this.#starting = this.#start(this.#fanoutSink())
      .then((handle) => {
        this.#starting = undefined
        this.#handle = handle
        return handle
      })
      .catch((error: unknown) => {
        this.#starting = undefined
        throw error
      })
    return this.#starting
  }

  #fanoutSink(): StreamSink {
    return {
      video: (chunk, meta) => {
        for (const viewer of [...this.#viewers]) {
          try {
            viewer.video(chunk, meta)
          } catch (error) {
            this.#onError(asError(error))
          }
        }
      },
      error: (error) => {
        const handle = this.#handle
        this.#handle = undefined
        if (handle) void safeStop(handle, this.#onError)
        for (const viewer of [...this.#viewers]) {
          try {
            viewer.error(error)
          } catch (cause) {
            this.#onError(asError(cause))
          }
        }
      },
    }
  }

  #scheduleStop(): void {
    this.#cancelGrace()
    if (this.#graceMs <= 0) {
      void this.stopNow()
      return
    }
    this.#graceTimer = this.#clock.setTimeout(() => {
      this.#graceTimer = undefined
      void this.stopNow()
    }, this.#graceMs)
  }

  #cancelGrace(): void {
    if (this.#graceTimer === undefined) return
    this.#clock.clearTimeout(this.#graceTimer)
    this.#graceTimer = undefined
  }
}

async function safeStop(handle: StreamHandle, onError: (error: Error) => void): Promise<void> {
  try {
    await handle.stop()
  } catch (error) {
    onError(asError(error))
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}