/**
 * scrcpy 会话（docs/architecture.md §4.2）：push scrcpy-server → start →
 * video/control socket → 异常退出清理。
 *
 * Host 零转码：video packet 的 `data` 原样交给 sink，不解码、不重编码。
 * 两种启动形态：
 * - `startStream`：video + control（人在看面板时）；
 * - `startControlOnly`：只建 control socket（Agent 输入文本/按键，无人看面板时，
 *   不启动视频编码、不浪费 CPU/带宽）。
 *
 * 本机无真机/scrcpy 二进制，pushServer/实连路径标注为未验证（见 docs/stream.md）。
 */

import { readFile } from 'node:fs/promises'

import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
import { ReadableStream } from '@yume-chan/stream-extra'

import type { AdbConnection } from '../adb/types.ts'
import { ScrcpyController } from './control.ts'
import { queryDeviceSize } from './device-size.ts'
import { ensureScrcpyServer, serverJarPath } from './jar-provider.ts'
import { DEFAULT_STREAM_OPTIONS } from './types.ts'
import type { StreamHandle, StreamInfo, StreamOptions, StreamSink } from './types.ts'

/** 推到设备的固定路径（scrcpy 官方默认位置）。 */
export const SERVER_JAR_REMOTE = '/data/local/tmp/scrcpy-server.jar'

// jar 路径/环境变量/懒下载集中在 jar-provider.ts；这里 re-export 保持既有 API。
export { SERVER_JAR_ENV } from './jar-provider.ts'
export { serverJarPath } from './jar-provider.ts'

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

type ScrcpyClient = AdbScrcpyClient<AdbScrcpyOptionsLatest<boolean>>
type ScrcpyVideoStream = NonNullable<Awaited<ScrcpyClient['videoStream']>>

/**
 * 启动 scrcpy 会话（video + control）。
 *
 * `extra.video === false` 时退化为 control-only（sink 不会被调用），等价
 * {@link startControlOnly}。失败时清理已建立的 socket/服务端进程后抛错。
 */
export async function startStream(
  adb: AdbConnection,
  options: StreamOptions,
  sink: StreamSink,
  extra: { video?: boolean } = {},
): Promise<StreamHandle> {
  return startSession(adb, options, extra.video === false ? undefined : sink)
}

/**
 * 只建 control socket（无视频编码）：供 Agent 的 INJECT_TEXT / keyevent 使用，
 * 即使右侧栏没有 viewer 也不需要开视频流（SPEC §3.6）。
 */
export async function startControlOnly(adb: AdbConnection, options: StreamOptions): Promise<StreamHandle> {
  return startSession(adb, options, undefined)
}

async function startSession(
  adb: AdbConnection,
  options: StreamOptions,
  sink: StreamSink | undefined,
): Promise<StreamHandle> {
  const opts = normalizeStreamOptions(options)
  const withVideo = sink !== undefined
  const jar = await loadServerJar()
  const raw = adb.raw

  // 启动时查询一次设备物理分辨率并缓存（wm size Physical size）；失败则省略字段。
  const deviceSize = await queryDeviceSize(adb).catch(() => undefined)

  const scrcpyOptions = new AdbScrcpyOptionsLatest<boolean>({
    video: withVideo,
    audio: false,
    control: true,
    maxSize: opts.maxSize,
    maxFps: opts.maxFps,
    videoBitRate: opts.bitrate,
    tunnelForward: false,
    logLevel: 'warn',
  })

  await AdbScrcpyClient.pushServer(raw, ReadableStream.from([jar]))

  let client: ScrcpyClient
  try {
    client = await AdbScrcpyClient.start(raw, SERVER_JAR_REMOTE, scrcpyOptions)
  } catch (error) {
    throw new Error('scrcpy server 启动失败: ' + errorMessage(error), { cause: error })
  }

  let video: ScrcpyVideoStream | undefined
  if (withVideo) {
    try {
      video = client.videoStream ? await client.videoStream : undefined
    } catch (error) {
      await client.close().catch(() => {})
      throw new Error('scrcpy 视频流建立失败: ' + errorMessage(error), { cause: error })
    }
    if (!video) {
      await client.close().catch(() => {})
      throw new Error('scrcpy 视频流建立失败: videoStream 为空')
    }
  }

  const controller = new ScrcpyController(client.controller, {
    width: video?.metadata.width ?? opts.maxSize,
    height: video?.metadata.height ?? opts.maxSize,
  })
  if (deviceSize) controller.setDeviceSize(deviceSize.width, deviceSize.height)
  if (video) bindSizeChanged(video, controller)
  return createHandle(client, video, controller, video ? streamInfo(video, deviceSize) : undefined, sink)
}

async function loadServerJar(): Promise<Uint8Array> {
  // 懒下载：缺失时自动调用 scripts/fetch-scrcpy-server.mjs 的下载器（single-flight +
  // sha256 校验 + 结构化错误），用户无需手工跑脚本。详见 jar-provider.ts。
  const path = await ensureScrcpyServer()
  try {
    const data = await readFile(path)
    return new Uint8Array(data)
  } catch (error) {
    throw new Error(
      '读取 scrcpy-server.jar 失败（' + path + '）：请重试或手工运行 node scripts/fetch-scrcpy-server.mjs',
      { cause: error },
    )
  }
}

function streamInfo(
  video: ScrcpyVideoStream,
  deviceSize: { width: number; height: number } | undefined,
): Promise<StreamInfo> {
  return Promise.resolve({
    width: video.metadata.width ?? 0,
    height: video.metadata.height ?? 0,
    codec: 'h264' as const,
    ...(deviceSize ? { deviceWidth: deviceSize.width, deviceHeight: deviceSize.height } : {}),
  })
}

function bindSizeChanged(video: ScrcpyVideoStream, controller: ScrcpyController): void {
  // @yume-chan/event 的 Event.on 未在本机验证；存在时用于同步触摸坐标基准。
  const event = video.sizeChanged as { on?: (handler: (size: { width: number; height: number }) => void) => unknown }
  event?.on?.((size) => controller.setScreenSize(size.width, size.height))
}

function createHandle(
  client: ScrcpyClient,
  video: ScrcpyVideoStream | undefined,
  controller: ScrcpyController,
  info: Promise<StreamInfo> | undefined,
  sink: StreamSink | undefined,
): StreamHandle {
  const reader = video?.stream.getReader()
  const videoSink = sink
  let stopped = false
  let failureSent = false

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    controller.close()
    if (reader) {
      try {
        await reader.cancel()
      } catch {
        // 读端已结束时 cancel 可能抛错，忽略。
      }
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
      videoSink?.error(error)
    } catch {
      // sink 是 ws 层；回调异常不得导致进程崩溃。
    }
    void stop()
  }

  if (reader && videoSink) {
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (stopped) break
          if (value.type === 'configuration') {
            videoSink.video(value.data)
          } else {
            videoSink.video(value.data, { keyframe: value.keyframe, pts: value.pts })
          }
        }
      } catch (error) {
        fail(new Error('scrcpy 视频流读取失败: ' + errorMessage(error), { cause: error }))
        return
      }
      if (!stopped) fail(new Error('scrcpy 视频流已结束（服务端退出）'))
    })().catch(() => {})
  }

  void client.exited.then(
    () => fail(new Error('scrcpy server 异常退出')),
    (error: unknown) => fail(new Error('scrcpy server 异常退出: ' + errorMessage(error), { cause: error })),
  ).catch(() => {})

  return { stop, controller, ...(info ? { info } : {}) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
