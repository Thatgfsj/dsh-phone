/**
 * e2e：真实 attach（可选）。只有显式设置 DSH_PHONE_E2E_ENDPOINT 时才跑；
 * 默认 skip 并写明原因，绝不把未测说成通过。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const endpointText = process.env.DSH_PHONE_E2E_ENDPOINT?.trim() ?? ''

test('真实 attach：TCP adbd 连接 + getprop + screencap', {
  skip: endpointText !== ''
    ? false
    : '未设置 DSH_PHONE_E2E_ENDPOINT（如 127.0.0.1:5555）：本机无真机、waydroid adb 端口不可达，attach 链路无法实测',
}, async () => {
  const { connect } = await import('../../src/adb/transport.ts')
  const { AdbDevice } = await import('../../src/adb/device.ts')
  const { parseEndpoint } = await import('../../src/adb/types.ts')

  const endpoint = parseEndpoint(endpointText)
  assert.ok(endpoint !== undefined, 'DSH_PHONE_E2E_ENDPOINT 必须是 host:port')
  const connection = await connect(endpoint, { timeoutMs: 8000 })
  try {
    const model = (await connection.shell('getprop ro.product.model')).trim()
    assert.ok(model.length > 0, 'getprop ro.product.model 不能为空')
    const device = new AdbDevice(connection)
    const png = await device.screenshot()
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'screencap 必须是 PNG')
  } finally {
    await connection.close()
  }
})
