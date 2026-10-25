/**
 * e2e 环境矩阵：本机缺失的运行时一律 test.skip 并写明原因，不允许假绿。
 *
 * 这些用例在具备对应环境（Docker + binder / Android emulator + AVD / 真机 /
 * scrcpy-server / 浏览器自动化）的机器上应改成真实用例；在补齐之前不允许删除
 * skip，也不允许让空测试体“通过”。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

function commandWorks(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5000 })
    return result.error === undefined && result.status === 0
  } catch {
    return false
  }
}

const docker = commandWorks('docker', ['version'])
const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.HOME ?? '', 'Android/Sdk')
const emulatorBinary = join(sdkRoot, 'emulator', 'emulator')
const emulator = existsSync(emulatorBinary) || commandWorks('emulator', ['-version'])
const scrcpyServer =
  (process.env.DSH_PHONE_SCRCPY_SERVER?.trim() || '') !== '' ||
  existsSync(join(process.cwd(), 'assets', 'scrcpy-server.jar'))

const REDROID_REASON = docker
  ? '本机有 Docker，但 redroid 需要一个已预拉的镜像、binder 模块与人工确认的容器实例；verify 不自动拉镜像/起容器（见 docs/verification.md 人工待办）'
  : '本机无 Docker（docker version 失败），redroid 无法启动：需 Docker + binder_linux 模块 + /dev/binder'

const EMULATOR_REASON = emulator
  ? '本机已有 emulator + AVD（dsh-phone-avd）；真实链路默认不跑：需显式 DSH_PHONE_E2E=1，且 emulator 自启（B 分支）需停用用户 live 实例，见 scripts/verify/verify-emulator.mjs 与 tests/e2e/real-emulator.test.mjs'
  : '本机无 Android SDK emulator 包 / AVD，emulator 运行时无法验证'

const SCRCPY_REASON = scrcpyServer
  ? 'scrcpy 实连由 scripts/verify/verify-emulator.mjs 在 DSH_PHONE_E2E=1 时覆盖（真实 emulator attach）；默认 verify 不碰设备'
  : '本机无 scrcpy-server jar（node scripts/fetch-scrcpy-server.mjs 可下载），且无真机/可用 attach 端点'

test('真实运行时：redroid（Docker + binder）', { skip: REDROID_REASON }, async () => {
  throw new Error('redroid e2e 未实现：需要人工在具备 docker + binder 的环境执行 docs/verification.md 的人工待办')
})

test('真实运行时：Android emulator（AVD headless）', { skip: EMULATOR_REASON }, async () => {
  throw new Error('emulator e2e 未实现：需要人工在具备 SDK emulator + AVD 的环境执行 docs/verification.md 的人工待办')
})

test('真实链路：scrcpy pushServer + 视频/控制 socket', { skip: SCRCPY_REASON }, async () => {
  throw new Error('scrcpy e2e 未实现：需要真机/可 attach 实例 + scrcpy-server jar')
})

test('真实浏览器：右栏面板 / WebCodecs(Annex-B) / TinyH264 回退 / 设置页', {
  skip: '本机无浏览器自动化依赖（未安装 playwright/puppeteer，也不允许为 verify 新增重型依赖）；页面渲染与解码属人工待办，见 docs/verification.md',
}, async () => {
  throw new Error('浏览器 e2e 未实现：需要 playwright/puppeteer 或人工页面验证')
})
