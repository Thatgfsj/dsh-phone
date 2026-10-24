/**
 * 视频流公共契约（docs/architecture.md §3.4、docs/protocol.md §2.2）。
 *
 * 分层：scrcpy.ts（采集/控制）→ session.ts（viewer 引用计数 + 宽限期）
 * → ws.ts（DPH1 封帧 + WebSocket 下行）。本文件只放类型，不引入运行时依赖。
 */

import type { AdbConnection } from '../adb/transport.ts'

export type { AdbConnection }

/** 触摸动作，与 WebSocket 文本协议一致（docs/protocol.md §2.3）。 */
export type TouchAction = 'down' | 'move' | 'up'

/** 一帧视频的元信息；Host 只透传，不解码。 */
export interface StreamVideoMeta {
  /** scrcpy 标记的关键帧。 */
  keyframe?: boolean
  /** scrcpy packet 自带的时间戳（微秒）；缺省时由 Host 生成 90kHz 时钟。 */
  pts?: bigint
}

/**
 * 视频流接收端（PhoneService/ws 层实现）。
 *
 * - video：一个 scrcpy packet 一次调用，chunk 为 H.264 Annex-B 原始负载；
 * - error：会话异常结束（启动失败/ADB 断开/服务端退出），调用后不会再收到 video。
 */
export interface StreamSink {
  video(chunk: Uint8Array, meta?: StreamVideoMeta): void
  error(error: Error): void
}

/** 流建立后的元信息（scrcpy video metadata，用于 ready 消息）。 */
export interface StreamInfo {
  width: number
  height: number
  codec: 'h264'
}

/**
 * 控制通道（scrcpy control socket）。
 *
 * 文本注入必须走这里（INJECT_TEXT），不得用 shell `input text`（SPEC §3.6）。
 */
export interface StreamController {
  /** 注入文本（支持中文）。 */
  injectText(text: string): Promise<void>
  /** 注入触摸事件，坐标为设备坐标。 */
  injectTouch(action: TouchAction, x: number, y: number): Promise<void>
  /** 注入按键（HOME/BACK/RECENTS/ENTER/DEL/...）。 */
  injectKey(name: string): Promise<void>
}

/** 一个运行中的 scrcpy 会话（同一时刻至多一个）。 */
export interface StreamHandle {
  /** 幂等停止会话：取消读取、关闭 control socket、结束服务端进程。 */
  stop(): Promise<void>
  controller: StreamController
  /** 流元信息；第一条 configuration packet 解析前可能尚未 resolve。 */
  info?: Promise<StreamInfo>
}

/** scrcpy 启动参数，来自 config.stream（spec §6.1），运行期不可随意改。 */
export interface StreamOptions {
  /** 长边像素，默认 720。 */
  maxSize: number
  /** 最大帧率，默认 15。 */
  maxFps: number
  /** 视频码率（bps），默认 2_000_000。 */
  bitrate: number
}

export const DEFAULT_STREAM_OPTIONS: StreamOptions = {
  maxSize: 720,
  maxFps: 15,
  bitrate: 2_000_000,
}

/**
 * ws 层依赖的 PhoneService 子集（冻结于 INTERFACES §3）。
 *
 * host 的 PhoneService 结构上满足本接口；stream 层不 import host 源码，避免循环依赖。
 */
export interface PhoneStreamService {
  /** 懒启动；booting 期间等待（超时由实现决定）。 */
  ensureRunning(): Promise<void>
  /**
   * 引用计数 +1 并返回 release；第 1 个 viewer 开流，最后一个 release 后
   * 宽限 5s 关流（docs/architecture.md §6）。
   */
  startStream(sink: StreamSink): Promise<() => Promise<void>>
  /** 面板触摸（设备坐标）。 */
  touch(action: TouchAction, x: number, y: number): Promise<void>
  /** 中文输入走 scrcpy 控制通道。 */
  inputText(text: string): Promise<void>
  /** 按键名 → keyevent。 */
  key(name: string): Promise<void>
}
