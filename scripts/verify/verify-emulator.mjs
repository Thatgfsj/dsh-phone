#!/usr/bin/env node
/**
 * verify-emulator：真实 emulator/attach 链路验收（issue #40，env-gated）。
 *
 * 默认 SKIP（不碰设备）：只有 DSH_PHONE_E2E=1 才执行。
 * 本机按 Lead 决策只跑 A 分支：复用用户 live 会话已拉起的 emulator
 * （127.0.0.1:5555），不启动/不停止该实例；B 分支（emulator 自启）SKIP。
 *
 * 场景与断言见 scripts/verify/shared/real-e2e.mjs：
 * 临时隔离 web profile → onboarding accepted + choice=attach → 认证 →
 * GET /screenshot 轮询 PNG → WS hello/ready + DPH1 帧统计 + key/touch/中文文本 →
 * 断开 5s 宽限后 GET /status 仍 running → 二次 WS 重建 → 只清理临时 web/profile。
 */
import { Cleanup, evidence, runScript, step } from './shared/harness.mjs'
import { runRealE2E } from './shared/real-e2e.mjs'

const enabled = process.env.DSH_PHONE_E2E === '1'
if (!enabled) {
  console.log(
    '[verify-emulator] SKIP：未设置 DSH_PHONE_E2E=1（真实设备链路默认不跑；' +
      '设置后需要 127.0.0.1:5555 有可用的 emulator/真机 adbd）。',
  )
  process.exit(0)
}

const cleanup = new Cleanup()

await runScript(async () => {
  const report = await step('真实 emulator attach 全链路（截图/WS/控制/释放）', async () => {
    return await runRealE2E({ cleanup })
  })
  if (report.skipped) {
    if (report.mode === 'emulator') {
      console.log('[verify-emulator] SKIP（B 分支按 Lead 决策不跑）：' + report.reason)
      return
    }
    throw new Error('DSH_PHONE_E2E=1 但真实链路未执行：' + report.reason)
  }
  evidence('total', '真实链路耗时 ' + report.durationMs + 'ms')
}, cleanup)
