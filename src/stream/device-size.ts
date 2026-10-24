/**
 * 设备真实分辨率（`adb shell wm size` 的 Physical size）。
 *
 * 用途：docs/protocol.md §2.3 的 `ready.deviceWidth/deviceHeight`——客户端用它把
 * 面板坐标换算成设备坐标；Host 侧再用它把设备坐标换算成 scrcpy 视频坐标注入。
 *
 * 「启动时查询一次并缓存」：按 adb endpoint 缓存（含解析失败的结果，避免每次连接
 * 都跑 shell）；单实例语义下（SPEC §3.3）同时把最近一次成功值放进进程级快照，
 * 供 ws 层在 ready 时同步读取。
 */

import type { AdbConnection } from '../adb/types.ts'

export interface DeviceSize {
  width: number
  height: number
}

const MIN_DIMENSION = 1
const MAX_DIMENSION = 100_000

/** 优先 Physical size；部分镜像只报 Override size 时回退。 */
const PHYSICAL_SIZE = /Physical size:\s*(\d+)\s*x\s*(\d+)/i
const OVERRIDE_SIZE = /Override size:\s*(\d+)\s*x\s*(\d+)/i

/** 解析 `wm size` 输出；解析失败返回 undefined（调用方省略字段，不猜）。 */
export function parseWmSize(output: string): DeviceSize | undefined {
  const match = PHYSICAL_SIZE.exec(output) ?? OVERRIDE_SIZE.exec(output)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!isValidDimension(width) || !isValidDimension(height)) return undefined
  return { width, height }
}

function isValidDimension(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION
}

let latest: DeviceSize | undefined

/** 进程级最近一次成功查询结果（单实例，ws ready 用）。 */
export function peekDeviceSize(): DeviceSize | undefined {
  return latest
}

/** 记录设备尺寸（scrcpy 启动时查询成功后调用；测试也可直接注入）。 */
export function recordDeviceSize(size: DeviceSize | undefined): void {
  latest = size ? { width: size.width, height: size.height } : undefined
}

/** 按 endpoint 缓存查询结果（undefined = 已查询但解析失败）。 */
export class DeviceSizeCache {
  #sizes = new Map<string, DeviceSize | undefined>()

  /** 查询一次并缓存；shell 失败/解析失败都返回 undefined（不抛给会话启动）。 */
  async get(adb: AdbConnection): Promise<DeviceSize | undefined> {
    const key = adb.endpoint.host + ':' + adb.endpoint.port
    if (this.#sizes.has(key)) return this.#sizes.get(key)
    let size: DeviceSize | undefined
    try {
      size = parseWmSize(await adb.shell('wm size'))
    } catch {
      size = undefined
    }
    this.#sizes.set(key, size)
    if (size) recordDeviceSize(size)
    return size
  }

  /** 清空缓存（runtime 重启/测试用）。 */
  clear(): void {
    this.#sizes.clear()
    recordDeviceSize(undefined)
  }
}

export const deviceSizeCache = new DeviceSizeCache()

/** 会话启动时调用：查询一次 wm size 并缓存。 */
export function queryDeviceSize(adb: AdbConnection): Promise<DeviceSize | undefined> {
  return deviceSizeCache.get(adb)
}
