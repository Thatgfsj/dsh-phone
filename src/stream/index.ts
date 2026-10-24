/**
 * stream 层稳定入口（host 只 import 本文件，不直接依赖内部实现文件）。
 *
 * 典型接线：
 * ```ts
 * import {
 *   startStream, startControlOnly, StreamSession,
 *   createStreamUpgradeRoute, type StreamSink, type StreamHandle,
 * } from './stream/index.ts'
 * ```
 *
 * - 有人看面板：`startStream(adb, config.stream, sink)`（video + control）；
 * - 无 viewer 但 Agent 要输入中文/按键：`startControlOnly(adb, config.stream)`
 *   （只建 control socket，不启动视频编码）；
 * - WS：`ctx.webServer.registerUpgrade(createStreamUpgradeRoute({ service, getConnection }))`。
 */

export {
  startStream,
  startControlOnly,
  normalizeStreamOptions,
  serverJarPath,
  SERVER_JAR_REMOTE,
} from './scrcpy.ts'
export { DEFAULT_STREAM_GRACE_MS, StreamSession } from './session.ts'
export type { SessionClock, StreamSessionOptions } from './session.ts'
export {
  DEFAULT_HELLO_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  STREAM_PATH,
  createStreamUpgradeHandler,
  createStreamUpgradeRoute,
  registerStreamRoute,
} from './ws.ts'
export type {
  StreamConnectionFence,
  StreamLogger,
  StreamRouteContext,
  StreamRouteDeps,
  StreamUpgradeDeps,
} from './ws.ts'
export {
  parseWmSize,
  peekDeviceSize,
  queryDeviceSize,
  recordDeviceSize,
} from './device-size.ts'
export type { DeviceSize } from './device-size.ts'
export { DEFAULT_STREAM_OPTIONS } from './types.ts'
export type {
  AdbConnection,
  PhoneStreamService,
  StreamController,
  StreamHandle,
  StreamInfo,
  StreamOptions,
  StreamSink,
  StreamVideoMeta,
  TouchAction,
} from './types.ts'
