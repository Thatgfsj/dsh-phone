/**
 * scrcpy 会话（docs/architecture.md §4.2）：push scrcpy-server → start →
 * video/control socket → 异常退出清理。
 *
 * Host 零转码：video packet 的 `data` 原样交给 sink，不解码、不重编码。
 * 本机无真机/scrcpy 二进制，pushServer/实连路径标注为未验证（见 docs/stream.md）。
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
import { ReadableStream } from '@yume-chan/stream-extra'

import type { AdbConnection } from '../adb/transport.ts'
import { ScrcpyController } from './control.ts'
import { DEFAULT_STREAM_OPTIONS } from './types.ts'
import type { StreamHandle, StreamInfo, StreamOptions, StreamSink } from './types.ts'

/** 推到设备的固定路径（scrcpy 官方默认位置）。 */
export const SERVER_JAR_REMOTE = '/data/local/tmp/scrcpy-server.jar'

/** 允许用环境变量覆盖 jar 路径（打包/测试用）。 */
export const SERVER_JAR_ENV = 'DSH_PHONE_SCRCPY_SERVER'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 本地 scrcpy-server.jar 路径：<repo>/assets/scrcpy-server.jar（scripts/fetch-scrcpy-server.mjs 下载）。 */
export function serverJarPath(): string {
  return process.env[SERVER_JAR_ENV] ?? resolve(HERE, '..', '..', 'assets', 'scrcpy-server.jar')
}

/** 校验并规范化 config.stream 参数（非法值回落到默认，避免把坏参数传给服务端）。 */
export function normalizeStreamOptions(options: Partial<StreamOptions> = {}): StreamOptions {
  return {
    maxSize: clampInt(options.maxSize, 1, 4096, DEFAULT_STREAM_OPTIONS.maxSize),
    maxFps: clampInt(options.maxFps, 1, 120, DEFAULT_STREAM_OPTIONS.maxFps),
    bitrate: clampInt(options.bitrate, 100_000, 100_000_000, DEFAULT_STREAM_OPTIONS.bitrate),
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

type ScrcpyVideoStream = Awaited<NonNullable<Awaited<ReturnType<AdbScrcpyClient['videoStream']>>>>

/**
 * 启动 scrcpy 会话。
 *
 * 失败时清理已建立的 socket/服务端进程后抛错，调用方（session/ws）负责
 * 把错误转成 `{type:'error',code:'E_STREAM_START_FAILED'}`。
 */
export async function startStream(
  adb: AdbConnection,
  options: StreamOptions,
  sink: StreamSink,
): Promise<StreamHandle> {
  const opts = normalizeStreamOptions(options)
  const jar = await loadServerJar()
  const raw = adb.raw

  const scrcpyOptions = new AdbScrcpyOptionsLatest({
    video: true,
    audio: false,
    control: true,
    maxSize: opts.maxSize,
    maxFps: opts.maxFps,
    videoBitRate: opts.bitrate,
    tunnelForward: false,
    logLevel: 'warn',
  })

  await AdbScrcpyClient.pushServer(raw, ReadableStream.from([jar]))

  let client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>
  try {
    client = await AdbScrcpyClient.start(raw, SERVER_JAR_REMOTE, scrcpyOptions)
  } catch (error) {
    throw new Error('scrcpy server 启动失败: ' + errorMessage(error), { cause: error })
  }

  let video: ScrcpyVideoStream
  try {
    video = await client.videoStream
  } catch (error) {
    await client.close().catch(() => {})
    throw new Error('scrcpy 视频流建立失败: ' + errorMessage(error), { cause: error })
  }

  const controller = new ScrcpyController(client.controller, {
    width: video.metadata.width ?? opts.maxSize,
    height: video.metadata.height ?? opts.maxSize,
  })
  const info = streamInfo(video)
  bindSizeChanged(video, controller)
  return createHandle(client, video, controller, info, sink)
}

async function loadServerJar(): Promise<Uint8Array> {
  try {
    const data = await readFile(serverJarPath())
    return new Uint8Array(data)
  } catch (error) {
    throw new Error(
      '找不到 scrcpy-server.jar（' + serverJarPath() + '）：请先运行 node scripts/fetch-scrcpy-server.mjs',
      { cause: error },
    )
  }
}

function streamInfo(video: ScrcpyVideoStream): Promise<StreamInfo> {
  return Promise.resolve({
    width: video.metadata.width ?? 0,
    height: video.metadata.height ?? 0,
    codec: 'h264' as const,
  })
}

function bindSizeChanged(video: ScrcpyVideoStream, controller: ScrcpyController): void {
  // @yume-chan/event 的 Event.on 未在本机验证；存在时用于同步触摸坐标基准。
  const event = video.sizeChanged as { on?: (handler: (size: { width: number; height: number }) => void) => unknown }
  event?.on?.((size) => controller.setScreenSize(size.width, size.height))
}

function createHandle(
  client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>,
  video: ScrcpyVideoStream,
  controller: ScrcpyController,
  info: Promise<StreamInfo>,
  sink: StreamSink,
): StreamHandle {
  const reader = video.stream.getReader()
  let stopped = false
  let failureSent = false

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    controller.close()
    try {
      await reader.cancel()
    } catch {
      // 读端已结束时 cancel 可能抛错，忽略。
    }
    try {
      await client.close()
    } catch {
      // 进程可能已退出；close 抛错不向外传播。
    }
  }

  const fail = (error: Error): void => {
    if (stopped || failureSent) return
    failureSent = true
    try {
      sink.error(error)
    } catch {
      // sink 是 ws 层；回调异常不得导致进程崩溃。
    }
    void stop()
  }

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (stopped) break
        if (value.type === 'configuration') {
          sink.video(value.data)
        } else {
          sink.video(value.data, { keyframe: value.keyframe, pts: value.pts })
        }
      }
    } catch (error) {
      fail(new Error('scrcpy 视频流读取失败: ' + errorMessage(error), { cause: error }))
      return
    }
    if (!stopped) fail(new Error('scrcpy 视频流已结束（服务端退出）'))
  })().catch(() => {})

  void client.exited.then(
    () => fail(new Error('scrcpy server 异常退出')),
    (error: unknown) => fail(new Error('scrcpy server 异常退出: ' + errorMessage(error), { cause: error })),
  ).catch(() => {})

  void Promise.resolve(adbDisconnected(client)).then(() => {
    fail(new Error('ADB 连接已断开'))
  }).catch(() => {})

  return { stop, controller, info }
}

/** client 挂载的 Adb 断连信号（yume-chan 客户端未直接暴露，退回 process 退出检测）。 */
function adbDisconnected(_client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>): Promise<void> {
  // 由 client.exited 覆盖；保留钩子便于后续接入 Adb.disconnected。
  return new Promise<void>(() => {})
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
