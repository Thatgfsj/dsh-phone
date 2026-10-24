/**
 * Host 层对运行时/ADB/流层的窄接口（结构类型）。
 *
 * 依赖方向（docs/architecture.md §1）：tools → phone → {runtime, adb, stream}。
 * 这里只放 host 侧消费的接口，实现分别属于 runtime（#3）与 stream（#5）两个 PR；
 * runtime/stream 尚未合并时，单测用假实现注入（tests/host/*）。
 */
import type { Endpoint, PhoneState, RuntimeKind } from '../runtime/types.ts'

export type { Endpoint, PhoneState, RuntimeKind }

export type Platform = 'linux' | 'windows' | 'macos' | 'other'

/** 对 Agent 暴露的状态（docs/protocol.md §1.1）。 */
export interface PhoneStatus {
  state: PhoneState
  runtime: RuntimeKind
  platform: Platform
  cpuPct?: number
  memPct?: number
  uptimeMs?: number
  bootMs?: number
  endpoint?: Endpoint
  lastError?: string
}

/** 工具前置检查：running 可直接执行；booting 返回可重试中间态（不报错）。 */
export type InteractiveReadiness =
  | { state: 'running' }
  | { state: 'booting'; bootMs: number }

/** 9 个工具 + HTTP 路由消费的 PhoneService 能力面（INTERFACES §3）。 */
export interface PhoneOperations {
  status(): Promise<PhoneStatus>
  ensureRunning(): Promise<void>
  /** 任意工具/面板交互的统一步骤：懒启动；已在 booting 时立即返回中间态。 */
  ensureInteractive(): Promise<InteractiveReadiness>
  screenshot(): Promise<Uint8Array>
  tap(x: number, y: number): Promise<void>
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>
  key(name: string): Promise<void>
  /** 必须走 scrcpy 控制通道 INJECT_TEXT（支持中文，SPEC §4）。 */
  inputText(text: string): Promise<void>
  appLaunch(pkg: string): Promise<void>
  dumpUi(): Promise<string>
  shell(command: string): Promise<string>
  touch(action: 'down' | 'move' | 'up', x: number, y: number): Promise<void>
  /** R5：不落盘的连通验证（connect + getprop ro.product.model）。 */
  verifyEndpoint(endpoint: string): Promise<VerifyResult>
}

export interface VerifyResult {
  ok: boolean
  latencyMs: number
  banner?: string
  error?: string
}

/** attachments 服务窄接口（calibration §1.5；可选，缺失时 phone_screenshot 降级文本）。 */
export interface AttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export interface AttachmentsLike {
  saveImage(input: {
    data: Uint8Array
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    name?: string
  }): Promise<AttachmentRef>
}
