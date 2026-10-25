/**
 * 真实 emulator/attach 链路验收（issue #40，A 分支：复用已在运行的 emulator）。
 *
 * 场景：隔离临时 web profile（onboarding accepted + choice=attach +
 * attach.endpoint=127.0.0.1:5555）→ 认证 → GET /screenshot 轮询到 PNG →
 * WS hello/ready + DPH1 帧统计 + key/touch/中文文本 → 关闭后 GET /status
 * 仍 running → 二次 WS 连接证明 viewer/stream 已释放 → 清理只停临时 web。
 *
 * 同时直连 stream 层（src/stream 的 startStream）做对照：若 Host WS 路径失败、
 * 而 stream 层直连成功，可把缺陷定位在 Host 接线（见 docs/verification.md）。
 *
 * B 分支（emulator 自启）本机 SKIP：5554/5555 已被用户 live dsh web 会话
 * 拉起的 emulator 占用，本验收不拥有该实例、不 SIGTERM 它；需停用 live 实例
 * 后再由 #40 人工清单覆盖。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'

import { assert, assertEqual, evidence } from './harness.mjs'
import { createWebProfile, fetchJson, isPng, sleep } from './web-profile.mjs'
import { probeStreamHandshake, runStreamScenario } from './ws-stream.mjs'

export const DEFAULT_ENDPOINT = '127.0.0.1:5555'
export const EVIDENCE_DIR =
  process.env.DSH_PHONE_E2E_EVIDENCE_DIR?.trim() || '/tmp/dsh-phone-e2e'

export function parseEndpointText(value) {
  const text = String(value ?? '').trim()
  const index = text.lastIndexOf(':')
  assert(index > 0 && index < text.length - 1, 'endpoint 必须是 host:port: ' + text)
  return { host: text.slice(0, index), port: Number(text.slice(index + 1)) }
}

/** TCP 连通性探测（attach/emulator 的 adbd 端口）。 */
export function probeTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolvePromise) => {
    const socket = netConnect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolvePromise(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 直连 ADB 读取设备信息（不经过插件；用于断言截图/视频尺寸与设备一致）。 */
export async function readDeviceInfo(endpointText) {
  const endpoint = parseEndpointText(endpointText)
  const { connect } = await import('../../../src/adb/transport.ts')
  const connection = await connect(endpoint, { timeoutMs: 8000 })
  try {
    const model = (await connection.shell('getprop ro.product.model')).trim()
    const wmSize = (await connection.shell('wm size')).trim()
    const match = /(?:Physical|Override) size:\s*(\d+)x(\d+)/.exec(wmSize)
    return {
      endpoint: endpointText,
      model,
      wmSize,
      width: match ? Number(match[1]) : undefined,
      height: match ? Number(match[2]) : undefined,
      serial: connection.serial,
    }
  } finally {
    await connection.close().catch(() => undefined)
  }
}

/** 模式决策：A 分支 attach 复用；B 分支 emulator 自启按 Lead 决策 SKIP。 */
export async function chooseMode(requested = 'auto', endpointText = DEFAULT_ENDPOINT) {
  const endpoint = parseEndpointText(endpointText)
  const reachable = await probeTcp(endpoint.host, endpoint.port)
  if (requested === 'emulator') {
    return {
      mode: 'emulator',
      reachable,
      skipReason:
        'emulator 自启（B 分支）本机 SKIP：' + endpointText +
        ' 已被用户 live dsh web 会话拉起的 emulator 占用；本验收不拥有该实例、不 SIGTERM 用户实例，需停用 live 实例后由 #40 人工清单覆盖',
    }
  }
  if (requested === 'attach') {
    assert(reachable, 'DSH_PHONE_E2E_MODE=attach 但 ' + endpointText + ' 不可达（需要已运行的 emulator/真机 adbd）')
    return { mode: 'attach', reachable }
  }
  if (reachable) return { mode: 'attach', reachable }
  return {
    mode: 'skip',
    reachable,
    skipReason:
      '未检测到 ' + endpointText + ' 的 adbd；emulator 自启（B 分支）按 Lead 决策不在本轮覆盖（避免与用户 live 实例冲突）',
  }
}

/** PNG IHDR 尺寸。 */
export function parsePngSize(bytes) {
  assert(isPng(bytes), '截图不是 PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** 轮询 GET /screenshot 直到 200 + PNG（冷启动 booting 可到 120s）。 */
export async function pollScreenshot({ origin, cookie, timeoutMs = 120_000, intervalMs = 1000 }) {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let attempts = 0
  let last = ''
  while (Date.now() < deadline) {
    attempts += 1
    try {
      const response = await fetch(origin + '/dsh-phone/api/screenshot', {
        headers: { cookie },
        signal: AbortSignal.timeout(30_000),
      })
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (response.status === 200 && isPng(bytes)) {
        return { bytes, attempts, ms: Date.now() - startedAt }
      }
      last =
        'status=' + response.status +
        ' content-type=' + (response.headers.get('content-type') ?? '') +
        ' body=' + new TextDecoder().decode(bytes.subarray(0, 240))
      if (/E_ONBOARDING/.test(last)) throw new Error('截图被 onboarding 守卫拒绝: ' + last)
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(intervalMs)
  }
  throw new Error('GET /screenshot 轮询超时（' + timeoutMs + 'ms, attempts=' + attempts + '），last=' + last)
}

/** 证据文件路径（/tmp 保留，供 PR 引用）。 */
function evidencePath(name) {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  return join(EVIDENCE_DIR, name)
}

/**
 * 直连 stream 层做对照：用真实 AdbConnection 调 src/stream 的 startStream，
 * 覆盖 scrcpy-server push、video 帧、controller 注入。用于区分 Host 接线缺陷。
 */
export async function runDirectStreamScenario(endpointText, options = {}) {
  const endpoint = parseEndpointText(endpointText)
  const captureMs = options.captureMs ?? 5000
  const { connect } = await import('../../../src/adb/transport.ts')
  const { startStream } = await import('../../../src/stream/index.ts')
  const connection = await connect(endpoint, { timeoutMs: 8000 })
  const frames = []
  const sinkErrors = []
  let handle
  const startedAt = Date.now()
  try {
    handle = await startStream(
      connection,
      { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
      {
        video(chunk, meta) {
          frames.push({ bytes: chunk.length, keyframe: meta?.keyframe === true, pts: meta?.pts })
        },
        error(error) {
          sinkErrors.push(error.message)
        },
      },
    )
    const info = await handle.info
    const startMs = Date.now() - startedAt
    await sleep(captureMs)
    const controlStartedAt = Date.now()
    await handle.controller.injectKey('HOME')
    await handle.controller.injectTouch('down', 360, 640)
    await handle.controller.injectTouch('up', 360, 640)
    await handle.controller.injectText('你好 e2e')
    return {
      ok: true,
      info,
      frameCount: frames.length,
      keyframes: frames.filter((frame) => frame.keyframe).length,
      firstFrameBytes: frames[0]?.bytes ?? 0,
      sinkErrors,
      startMs,
      observedMs: Date.now() - startedAt,
      controlMs: Date.now() - controlStartedAt,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error?.cause?.message,
      frameCount: frames.length,
      sinkErrors,
      observedMs: Date.now() - startedAt,
    }
  } finally {
    if (handle) await handle.stop().catch(() => undefined)
    await connection.close().catch(() => undefined)
  }
}

/**
 * 跑完整 A 分支真实链路；返回 report（skipped=true 表示环境不满足，调用方决定 fail/skip）。
 * Host WS 视频流失败时仍写 report（含缺陷分类）并抛错，保证失败非零退出。
 */
export async function runRealE2E(options = {}) {
  const cleanup = options.cleanup
  assert(cleanup !== undefined, 'runRealE2E 需要传入 Cleanup（保证临时 web/profile 回收）')
  const endpointText = options.endpoint ?? DEFAULT_ENDPOINT
  const requestedMode = options.requestedMode ?? process.env.DSH_PHONE_E2E_MODE?.trim() ?? 'auto'
  const startedAt = Date.now()

  const decision = await chooseMode(requestedMode, endpointText)
  if (decision.mode === 'emulator' || decision.mode === 'skip') {
    return { skipped: true, reason: decision.skipReason, mode: decision.mode, endpoint: endpointText }
  }
  evidence('mode', 'attach（复用已运行实例，未由插件启动、不停止）')

  const device = await readDeviceInfo(endpointText)
  evidence('device', device.model + ' / ' + device.wmSize + ' / serial=' + device.serial)

  const configLines = [
    'runtime: attach',
    'onboarding:',
    '  status: accepted',
    '  choice: attach',
    'attach:',
    '  endpoint: ' + endpointText,
    '  resolved: true',
    'stream:',
    '  maxSize: 720',
    '  maxFps: 15',
    '  bitrate: 2000000',
  ]
  const context = await createWebProfile({ cleanup, configLines })
  evidence('web', context.origin + '（隔离临时 DSH_HOME=' + context.home + '）')

  const config = await fetchJson(context.origin + '/dsh-phone/api/config', { headers: { cookie: context.cookie } })
  assertEqual(config.response.status, 200, 'GET /config 必须 200')
  assertEqual(config.body?.ok, true, 'config ok=true')
  assertEqual(config.body.value.onboarding.status, 'accepted', 'onboarding.status 必须 accepted')
  assertEqual(config.body.value.onboarding.choice, 'attach', 'onboarding.choice 必须 attach')
  assertEqual(config.body.value.runtime, 'attach', 'effective runtime 必须 attach')
  assertEqual(config.body.value.attach.endpoint, endpointText, 'attach.endpoint 必须生效')
  assertEqual(config.body.value.attach.resolved, true, 'attach.resolved 必须生效')
  evidence('config', JSON.stringify(config.body.value))

  const screenshot = await pollScreenshot({ origin: context.origin, cookie: context.cookie })
  const pngSize = parsePngSize(screenshot.bytes)
  const pngPath = evidencePath('screenshot-' + startedAt + '.png')
  writeFileSync(pngPath, screenshot.bytes)
  if (device.width && device.height) {
    assertEqual(pngSize.width, device.width, '截图宽度必须等于设备 wm size 宽度')
    assertEqual(pngSize.height, device.height, '截图高度必须等于设备 wm size 高度')
  }
  evidence('screenshot', pngSize.width + 'x' + pngSize.height + '，' + screenshot.bytes.length + ' bytes，attempts=' + screenshot.attempts + '，' + screenshot.ms + 'ms，保存=' + pngPath)

  // 1) Host WS 路径：握手/hello/首个 ready-or-error（缺陷时拿到结构化 error，不卡死）。
  const handshake = await probeStreamHandshake({
    origin: context.origin,
    cookie: context.cookie,
    timeoutMs: 45_000,
  })
  let hostStream
  if (handshake.ok) {
    const stream = await runStreamScenario({ origin: context.origin, cookie: context.cookie })
    assertEqual(stream.errorTexts.length, 0, 'WS 不得出现 error 文本帧: ' + JSON.stringify(stream.errorTexts))
    assertEqual(stream.socketErrors.length, 0, 'WS 不得出现 socket 错误: ' + JSON.stringify(stream.socketErrors))
    assertEqual(stream.invalidFrames, 0, 'WS 不得出现非 DPH1 二进制帧')
    assertEqual(stream.ready.codec, 'h264', 'ready.codec 必须是 h264')
    assert(stream.frameCount >= 3, '10s 内至少应收到 3 个 DPH1 视频帧，实际 ' + stream.frameCount)
    assert(stream.configurationFrames >= 1, '必须收到 configuration(SPS/PPS) 帧')
    assert(stream.keyFrames >= 1, '必须收到 keyframe 帧')
    if (stream.ready.deviceWidth !== undefined) {
      assertEqual(stream.ready.deviceWidth, device.width, 'ready.deviceWidth 必须等于设备宽度')
      assertEqual(stream.ready.deviceHeight, device.height, 'ready.deviceHeight 必须等于设备高度')
    }
    assertEqual(stream.controlErrorCount, 0, '控制消息（key/touch/text）不得产生 error 帧')
    hostStream = {
      ok: true,
      ready: stream.ready,
      frameCount: stream.frameCount,
      configurationFrames: stream.configurationFrames,
      keyFrames: stream.keyFrames,
      deltaFrames: stream.deltaFrames,
      observedMs: stream.observedMs,
      approxFps: stream.approxFps,
      controlSent: stream.controlSent,
    }
    evidence('host-stream', 'ready codec=' + stream.ready.codec + ' ' + stream.ready.width + 'x' + stream.ready.height + '；' + stream.frameCount + ' 帧，config=' + stream.configurationFrames + ' key=' + stream.keyFrames + ' delta=' + stream.deltaFrames)
    evidence('host-control', stream.controlSent.join(' / ') + ' → error 帧 0')
  } else {
    hostStream = { ok: false, error: handshake.error, texts: handshake.texts.map((message) => message.type), timeout: handshake.timeout === true, closed: handshake.closed === true }
    evidence('host-stream', 'FAILED：' + JSON.stringify(handshake.error ?? { timeout: handshake.timeout, closed: handshake.closed }))
  }

  // 2) stream 层直连对照：用于定位 Host 接线 vs stream/scrcpy 实现。
  const directStream = await runDirectStreamScenario(endpointText)
  assert(directStream.ok, 'stream 层直连失败: ' + directStream.error)
  assert(directStream.frameCount >= 10, 'stream 层 5s 内至少应收到 10 帧，实际 ' + directStream.frameCount)
  assert(directStream.keyframes >= 1, 'stream 层必须收到 keyframe')
  assertEqual(directStream.sinkErrors.length, 0, 'stream 层 sink 不得报错')
  if (device.width && device.height) {
    assertEqual(directStream.info?.deviceWidth, device.width, 'stream info.deviceWidth 必须等于设备宽度')
    assertEqual(directStream.info?.deviceHeight, device.height, 'stream info.deviceHeight 必须等于设备高度')
  }
  evidence('direct-stream', 'scrcpy push/start ' + directStream.startMs + 'ms；' + directStream.frameCount + ' 帧，key=' + directStream.keyframes + '，video=' + directStream.info?.width + 'x' + directStream.info?.height + '，control ' + directStream.controlMs + 'ms')

  // 3) Host 释放：WS 关闭后 5s 宽限，实例仍 running（不停止 attach 实例）。
  let release
  if (hostStream.ok) {
    await sleep(6500)
    const status = await fetchJson(context.origin + '/dsh-phone/api/status', {
      headers: { 'x-dsh-phone-token': context.agentToken },
    })
    assertEqual(status.response.status, 200, 'GET /status 必须 200')
    assertEqual(status.body?.ok, true, 'status ok=true')
    assertEqual(status.body.value.state, 'running', 'WS 关闭 + 5s 宽限后实例必须仍 running')
    assertEqual(status.body.value.runtime, 'attach', 'status.runtime 必须 attach')
    assertEqual(status.body.value.endpoint?.port, parseEndpointText(endpointText).port, 'status.endpoint.port')
    const second = await runStreamScenario({
      origin: context.origin,
      cookie: context.cookie,
      frameWindowMs: 3000,
      readyTimeoutMs: 120_000,
    })
    assert(second.frameCount >= 1, '二次连接应重新收到视频帧')
    release = { status: status.body.value.state, secondConnectFrames: second.frameCount, viewerReleased: true }
    evidence('release', 'WS 关闭 + 6.5s 后 state=running；二次连接重建成功（' + second.frameCount + ' 帧）')
  } else {
    const status = await fetchJson(context.origin + '/dsh-phone/api/status', {
      headers: { 'x-dsh-phone-token': context.agentToken },
    })
    assertEqual(status.response.status, 200, 'GET /status 必须 200')
    assertEqual(status.body.value.state, 'running', 'Host WS 失败不应影响实例状态（应仍 running）')
    release = { status: status.body.value.state, viewerReleased: false, notApplicable: 'Host WS 未建立视频流，无 viewer 可释放' }
    evidence('release', 'Host WS 未建立（缺陷），GET /status state=' + status.body.value.state)
  }

  // 4) 清理只停临时 web；用户 live emulator 必须仍可达。
  const webExit = await context.web.stop()
  const stillReachable = await probeTcp(parseEndpointText(endpointText).host, parseEndpointText(endpointText).port)
  assert(stillReachable, '清理临时 web 后 emulator/adbd 必须仍可达（本验收不得停止用户实例）')
  evidence('cleanup', '临时 web 退出=' + JSON.stringify(webExit) + '；emulator 仍可达=' + stillReachable + '（未由本次启动、未停止）')

  const defect = hostStream.ok
    ? undefined
    : {
        id: 'host-adb-raw-double-unwrap',
        summary: 'Host PhoneService 把 AdbConnection.raw 传给 stream 层，stream 再读 .raw 得到 undefined，pushServer 报 Cannot read properties of undefined (reading sync)',
        where: 'src/phone/service.ts:331/534（startStream/control session 传 this.#requireConnection().raw）；src/stream/scrcpy.ts:81 期望 AdbConnection 并读 .raw',
        evidence: hostStream.error?.message,
        impact: '真实设备上视频流（WS）与中文输入/触摸控制通道不可用；截图（shell）不受影响',
      }

  const report = {
    skipped: false,
    mode: 'attach',
    endpoint: endpointText,
    device,
    origin: context.origin,
    config: config.body.value,
    screenshot: {
      path: pngPath,
      bytes: screenshot.bytes.length,
      width: pngSize.width,
      height: pngSize.height,
      attempts: screenshot.attempts,
      ms: screenshot.ms,
    },
    hostStream,
    directStream: {
      ok: directStream.ok,
      info: directStream.info,
      frameCount: directStream.frameCount,
      keyframes: directStream.keyframes,
      startMs: directStream.startMs,
      observedMs: directStream.observedMs,
      controlMs: directStream.controlMs,
    },
    release,
    defect,
    emulator: { startedByPlugin: false, preexisting: true, stopped: false, stillReachableAfterCleanup: stillReachable },
    durationMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
  }
  writeFileSync(evidencePath('report.json'), JSON.stringify(report, null, 2) + '\n')
  evidence('report', evidencePath('report.json'))

  if (!hostStream.ok) {
    throw new Error(
      'Host WS 视频流失败（真实缺陷 ' + defect.id + '）：' + defect.evidence +
        '；但 stream 层直连成功（' + directStream.frameCount + ' 帧，control OK），缺陷在 Host 接线。' +
        ' 详见 ' + evidencePath('report.json') + ' 与 docs/verification.md',
    )
  }
  return report
}
