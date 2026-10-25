/**
 * e2e：真实 emulator/attach 全链路（可选，env-gated）。
 *
 * 默认 skip；只有 DSH_PHONE_E2E=1 才跑。断言内容由
 * scripts/verify/shared/real-e2e.mjs 实现（截图 PNG、WS DPH1 帧、控制通道、
 * 断开后 Host 仍 running、二次连接重建、清理不停止用户 emulator）。
 *
 * 本机 A 分支复用用户 live dsh web 会话已拉起的 emulator（127.0.0.1:5555），
 * 不拥有、不停止；B 分支（emulator 自启）需停用 live 实例后人工覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const enabled = process.env.DSH_PHONE_E2E === '1'

test('真实 emulator attach：截图 PNG / WS DPH1 / 控制 / 释放', {
  skip: enabled
    ? false
    : '未设置 DSH_PHONE_E2E=1（真实设备链路默认 skip；设置后需 127.0.0.1:5555 有 emulator/真机 adbd）',
}, async () => {
  const { Cleanup } = await import('../../scripts/verify/shared/harness.mjs')
  const { runRealE2E } = await import('../../scripts/verify/shared/real-e2e.mjs')
  const cleanup = new Cleanup()
  try {
    const report = await runRealE2E({ cleanup })
    assert.equal(report.skipped, false, 'DSH_PHONE_E2E=1 但真实链路未执行: ' + report.reason)
    assert.equal(report.screenshot.width > 0, true)
    assert.equal(report.stream.frameCount > 0, true)
    assert.equal(report.release.status.state, 'running')
  } finally {
    await cleanup.run()
  }
})
