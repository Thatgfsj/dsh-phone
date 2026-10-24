import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  ATTACH_COMMON_PORTS,
  AVD_NAME,
  INSTALL_DOCS,
  INSTALL_GUIDE_INTRO,
  ONBOARDING_INSTALL_COMMANDS,
  SCRCPY_FETCH_COMMAND,
  SYSTEM_IMAGE,
  attachCommands,
  attachHint,
  createOnboardingInstallPayload,
  emulatorCommands,
  installGuide,
  installGuideData,
  installGuideHints,
  redroidCommands,
  redroidRunArgs,
  renderInstallGuide,
  sdkmanagerPath,
} from '../../src/runtime/install-guide.ts'
import { DEFAULT_RUNTIME_OPTIONS } from '../../src/runtime/types.ts'
import type { Platform } from '../../src/runtime/types.ts'

const ALL_PLATFORMS: readonly Platform[] = ['linux', 'windows', 'macos', 'other']

function flatHints(platform: Platform): string {
  return installGuideHints(platform).join('\n')
}

describe('install-guide：命令快照（文案漂移守卫）', () => {
  test('emulator 三条命令与 SPEC/issue 一致', () => {
    assert.deepEqual(
      emulatorCommands('linux').map((item) => item.command),
      [
        'sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"',
        'avdmanager create avd -n dsh-phone-avd -k "system-images;android-34;google_apis;x86_64"',
        'emulator -avd dsh-phone-avd -no-window',
      ],
    )
    assert.equal(AVD_NAME, 'dsh-phone-avd')
    assert.equal(SYSTEM_IMAGE, 'system-images;android-34;google_apis;x86_64')
  })

  test('redroid 四条命令（binder + 检查 + docker info + docker run）', () => {
    assert.deepEqual(
      redroidCommands().map((item) => item.command),
      [
        'sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"',
        'ls -l /dev/binder',
        'docker info | head -5',
        'docker run -d --name dsh-phone-redroid --restart=no --privileged --memory 2g --cpus 2 ' +
          '-v /lib/modules:/lib/modules:ro -p 127.0.0.1:5555:5555 redroid/redroid:14-latest',
      ],
    )
  })

  test('attach 各平台端口探测命令快照', () => {
    assert.deepEqual(
      attachCommands('windows').map((item) => item.command),
      [
        'Test-NetConnection 127.0.0.1 -Port 5555',
        'Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 5555,62001,16384,21503',
      ],
    )
    assert.deepEqual(
      attachCommands('macos').map((item) => item.command),
      ['lsof -nP -iTCP:5555 -sTCP:LISTEN', 'nc -z 127.0.0.1 5555 && echo open'],
    )
    const linux = attachCommands('linux').map((item) => item.command)
    assert.match(linux[0]!, new RegExp(`ss -ltn | grep -E ':(${ATTACH_COMMON_PORTS.join('|')})$'`))
    assert.equal(linux[1], 'nc -z 127.0.0.1 5555 && echo open')
  })

  test('redroid docker run 参数从 DEFAULT_RUNTIME_OPTIONS 派生（与适配器不漂移）', () => {
    const args = redroidRunArgs(DEFAULT_RUNTIME_OPTIONS.redroid)
    assert.equal(args[0], 'run')
    assert.ok(args.includes(DEFAULT_RUNTIME_OPTIONS.redroid.image))
    assert.ok(args.includes(DEFAULT_RUNTIME_OPTIONS.redroid.memLimit))
    assert.ok(args.includes(String(DEFAULT_RUNTIME_OPTIONS.redroid.vcpuLimit)))
    assert.ok(args.includes('127.0.0.1:5555:5555'))
  })
})

describe('install-guide：linux hints（redroid 优先）', () => {
  test('含 emulator 三条可复制命令', () => {
    const text = flatHints('linux')
    assert.match(text, /sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"/)
    assert.match(text, /avdmanager create avd -n dsh-phone-avd -k /)
    assert.match(text, /emulator -avd dsh-phone-avd -no-window/)
  })

  test('含 redroid 完整命令 + /dev/binder 检查', () => {
    const text = flatHints('linux')
    assert.match(text, /sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"/)
    assert.match(text, /ls -l \/dev\/binder/)
    assert.match(text, /docker run -d --name dsh-phone-redroid .* redroid\/redroid:14-latest/)
  })

  test('含 attach 端口探测 + 设置页填 endpoint 指引', () => {
    const text = flatHints('linux')
    assert.match(text, /ss -ltn/)
    assert.match(text, /nc -z 127\.0\.0\.1 5555/)
    assert.match(attachHint(), /设置 → 手机 → attach\.endpoint/)
    assert.match(text, /attach\.endpoint/)
  })

  test('含 scrcpy-server 手工下载命令与 #37 自动下载提示', () => {
    const text = flatHints('linux')
    assert.ok(text.includes(SCRCPY_FETCH_COMMAND))
    assert.match(text, /#37/)
    assert.match(text, /自动下载/)
  })

  test('章节顺序：redroid → emulator → attach → scrcpy', () => {
    assert.deepEqual(
      installGuideData('linux').sections.map((section) => section.id),
      ['redroid', 'emulator', 'attach', 'scrcpy'],
    )
  })
})

describe('install-guide：windows / macos hints', () => {
  test('windows：sdkmanager + Test-NetConnection + WHPX 提示', () => {
    const text = flatHints('windows')
    assert.match(text, /sdkmanager "emulator"/)
    assert.match(text, /avdmanager create avd -n dsh-phone-avd/)
    assert.match(text, /emulator -avd dsh-phone-avd -no-window/)
    assert.match(text, /Test-NetConnection 127\.0\.0\.1 -Port 5555/)
    assert.match(text, /WHPX/)
    assert.match(text, /sdkmanager\.bat/)
  })

  test('windows：redroid 仅给进阶说明，不给 docker run（避免误导）', () => {
    const text = flatHints('windows')
    assert.match(text, /WSL2/)
    assert.match(text, /默认不推荐/)
    assert.doesNotMatch(text, /docker run /)
    assert.deepEqual(
      installGuideData('windows').sections.map((section) => section.id),
      ['emulator', 'redroid', 'attach', 'scrcpy'],
    )
  })

  test('macos：sdkmanager + lsof + nc', () => {
    const text = flatHints('macos')
    assert.match(text, /sdkmanager "emulator"/)
    assert.match(text, /lsof -nP -iTCP:5555 -sTCP:LISTEN/)
    assert.match(text, /nc -z 127\.0\.0\.1 5555 && echo open/)
    assert.match(text, /Hypervisor\.framework/)
  })

  test('other：attach 优先且给出既有限制说明', () => {
    const guide = installGuideData('other')
    assert.deepEqual(
      guide.sections.map((section) => section.id),
      ['attach', 'redroid', 'scrcpy'],
    )
    assert.match(flatHints('other'), /当前平台不受支持/)
  })
})

describe('install-guide：文本渲染与 hints 一致性（防漂移）', () => {
  test('每个平台的每条命令都同时出现在 hints 与渲染文本中', () => {
    for (const platform of ALL_PLATFORMS) {
      const guide = installGuideData(platform)
      const hints = installGuideHints(platform).join('\n')
      const text = installGuide(platform)
      for (const section of guide.sections) {
        for (const command of section.commands) {
          assert.ok(hints.includes(command.command), `hints 缺少命令: ${platform} ${command.command}`)
          assert.ok(text.includes(command.command), `渲染文本缺少命令: ${platform} ${command.command}`)
        }
      }
    }
  })

  test('渲染文本结构稳定（intro / 文档尾行 / 命令无提示符）', () => {
    for (const platform of ALL_PLATFORMS) {
      const text = installGuide(platform)
      assert.ok(text.startsWith(INSTALL_GUIDE_INTRO))
      assert.ok(text.endsWith(`文档：${INSTALL_DOCS}`))
      assert.equal(text, renderInstallGuide(installGuideData(platform)))
      for (const line of text.split('\n')) {
        assert.doesNotMatch(line, /^\s*\$\s/, '命令不应带 $ 提示符（不利于整行复制）')
      }
    }
  })

  test('sdkmanagerPath 按平台给出常见绝对路径', () => {
    assert.match(sdkmanagerPath('windows'), /sdkmanager\.bat$/)
    assert.match(sdkmanagerPath('macos'), /Library\/Android\/sdk/)
    assert.match(sdkmanagerPath('linux'), /^\$ANDROID_HOME/)
  })
})

describe('install-guide：onboarding 载荷共用同一数据源', () => {
  test('payload 形状与命令来自构建器（不是第二份文案）', () => {
    const payload = createOnboardingInstallPayload()
    const emulator = emulatorCommands('linux').map((item) => item.command)
    const redroid = redroidCommands().map((item) => item.command)
    assert.deepEqual(payload.emulator.commands, emulator)
    assert.deepEqual(payload.redroid.commands, redroid)
    assert.equal(payload.emulator.size, '~1.7GB')
    assert.equal(payload.attach.hint, attachHint())
  })

  test('payload 的每条命令都能在 linux 安装指引里找到（零漂移）', () => {
    const text = installGuide('linux')
    const payload = createOnboardingInstallPayload()
    for (const command of [...payload.emulator.commands, ...payload.redroid.commands]) {
      assert.ok(text.includes(command), `安装指引缺少 onboarding 命令: ${command}`)
    }
  })

  test('客户端卡片命令同样来自构建器', () => {
    assert.equal(ONBOARDING_INSTALL_COMMANDS.emulator, emulatorCommands('linux')[0]!.command)
    assert.equal(ONBOARDING_INSTALL_COMMANDS.redroid, redroidCommands()[0]!.command)
    assert.match(ONBOARDING_INSTALL_COMMANDS.emulator, /^sdkmanager /)
    assert.match(ONBOARDING_INSTALL_COMMANDS.redroid, /^sudo modprobe binder_linux /)
  })

  test('配置默认值与命令中的资源参数一致', () => {
    const text = flatHints('linux')
    assert.ok(text.includes(DEFAULT_RUNTIME_OPTIONS.redroid.image))
    assert.ok(text.includes(`--memory ${DEFAULT_RUNTIME_OPTIONS.redroid.memLimit}`))
    assert.ok(text.includes(`--cpus ${DEFAULT_RUNTIME_OPTIONS.redroid.vcpuLimit}`))
  })
})
