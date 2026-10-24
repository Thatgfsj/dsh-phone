/**
 * 安装指引与「可复制安装命令」的**单一数据源**（issue #38）。
 *
 * 同一份数据同时供：
 * 1. `detect.ts` → `RuntimeUnavailableError.hints`（phone_status / 9 个工具的安装指引）；
 * 2. host 首次使用守卫的 `onboarding.install` 载荷（`src/config/onboarding.ts`）；
 * 3. 客户端引导卡片展示的命令（`src/client/onboarding.ts`）。
 *
 * 约束：
 * - **纯数据 + 纯函数**，不 import 任何 Node 内置模块（Client bundle 也要能用）；
 * - 只给命令、不执行（SPEC §6.4：插件不安装任何软件）；
 * - 命令中的镜像/内存/vCPU/端口从 {@link DEFAULT_RUNTIME_OPTIONS} 派生，避免与适配器漂移。
 */

import type { Platform, RedroidOptions } from './types.ts'
import { DEFAULT_RUNTIME_OPTIONS } from './types.ts'

export type InstallSectionId = 'emulator' | 'redroid' | 'attach' | 'scrcpy'

/** 一条可复制命令（`command` 不带 `$`/`#` 提示符，便于整行复制）。 */
export interface InstallCommand {
  command: string
  /** 命令说明，不随命令复制。 */
  note?: string
}

export interface InstallSection {
  id: InstallSectionId
  title: string
  commands: InstallCommand[]
  notes?: string[]
}

/** 结构化安装指引（同时可用于 JSON 载荷与文本渲染）。 */
export interface InstallGuideData {
  platform: Platform
  intro: string
  sections: InstallSection[]
  docs: string
}

/** 首次使用守卫的 `install` 载荷形状（保持与 src/config/onboarding.ts 旧契约一致）。 */
export interface OnboardingInstallCommands {
  emulator: { commands: string[]; size: string }
  redroid: { commands: string[] }
  attach: { hint: string }
}

/* --------------------------------- 常量 ---------------------------------- */

/** 与 `src/runtime/emulator.ts` 自动创建 AVD 时使用的名字保持一致。 */
export const AVD_NAME = 'dsh-phone-avd'
/** 与 `emulator.ts` 自动创建 AVD 时使用的 system image 保持一致。 */
export const SYSTEM_IMAGE = 'system-images;android-34;google_apis;x86_64'
export const EMULATOR_PACKAGE = 'emulator'
export const SCRCPY_FETCH_COMMAND = 'node scripts/fetch-scrcpy-server.mjs'
export const INSTALL_DOCS = 'docs/install.md'
export const ONBOARDING_EMULATOR_SIZE = '~1.7GB'
/** 常见模拟器/AVD 的宿主 adb 端口（仅作线索，必须实测，SPEC §5.2 步骤 3）。 */
export const ATTACH_COMMON_PORTS = [5555, 62001, 16384, 16416, 21503] as const
export const ATTACH_DEFAULT_PORT = 5555

export const INSTALL_GUIDE_INTRO =
  '没有可用的 Android 运行时。下面是你需要在自己的终端执行的命令（插件只展示、不执行，也不会替你安装软件）：'

/* ------------------------------- 命令构建器 ------------------------------- */

/** 各平台 sdkmanager 的常见绝对路径（不在 PATH 时使用）。 */
export function sdkmanagerPath(platform: Platform): string {
  if (platform === 'windows') {
    return '%LOCALAPPDATA%\\Android\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat'
  }
  if (platform === 'macos') {
    return '$HOME/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager'
  }
  return '$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager'
}

/** Android SDK Emulator 的三步安装命令（sdkmanager → avdmanager → emulator）。 */
export function emulatorCommands(
  platform: Platform,
  options: { avdName?: string; systemImage?: string } = {},
): InstallCommand[] {
  const avdName = options.avdName?.trim() || AVD_NAME
  const systemImage = options.systemImage?.trim() || SYSTEM_IMAGE
  const accelNote =
    platform === 'windows'
      ? '需要 WHPX/「虚拟机平台」与 BIOS 虚拟化；可用 emulator -accel-check 自检'
      : platform === 'macos'
        ? '使用 Hypervisor.framework（默认可用）'
        : '需要 /dev/kvm（BIOS 开启虚拟化并加载 kvm 模块）'
  return [
    {
      command: `sdkmanager "${EMULATOR_PACKAGE}" "${systemImage}"`,
      note: `若 sdkmanager 不在 PATH：${sdkmanagerPath(platform)}；装了 Android Studio 时自带 cmdline-tools`,
    },
    {
      command: `avdmanager create avd -n ${avdName} -k "${systemImage}"`,
      note: '已有同名 AVD 时可跳过；重建先执行 avdmanager delete avd -n ' + avdName,
    },
    {
      command: `emulator -avd ${avdName} -no-window`,
      note: `插件自己会用 headless 参数启动；本命令用于人工验证能否起来。${accelNote}`,
    },
  ]
}

/** redroid 的 `docker run` 参数（与 RedroidRuntime 实际使用的参数保持一致）。 */
export function redroidRunArgs(redroid: RedroidOptions): string[] {
  const port = redroid.port ?? ATTACH_DEFAULT_PORT
  const containerName = redroid.containerName ?? 'dsh-phone-redroid'
  return [
    'run',
    '-d',
    '--name',
    containerName,
    '--restart=no',
    '--privileged',
    '--memory',
    redroid.memLimit,
    '--cpus',
    String(redroid.vcpuLimit),
    '-v',
    '/lib/modules:/lib/modules:ro',
    '-p',
    `127.0.0.1:${port}:5555`,
    redroid.image,
  ]
}

/** redroid 的完整可复制命令（binder 模块 + 设备节点检查 + docker run）。 */
export function redroidCommands(
  redroid: RedroidOptions = DEFAULT_RUNTIME_OPTIONS.redroid,
): InstallCommand[] {
  return [
    {
      command: 'sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"',
      note: '加载 binder 模块；重启后可能需要重新加载（可写入 /etc/modules-load.d）',
    },
    { command: 'ls -l /dev/binder', note: '必须存在，否则决策树第 1 步不会命中' },
    { command: 'docker info | head -5', note: '确认 Docker 守护进程可用、当前用户有权限' },
    {
      command: `docker ${redroidRunArgs(redroid).join(' ')}`,
      note: `启动 redroid 容器（默认映射 127.0.0.1:${redroid.port ?? ATTACH_DEFAULT_PORT}）；插件不会执行本命令`,
    },
  ]
}

/** 查 adb 端口 + 在设置页填 endpoint 的命令/操作指引。 */
export function attachCommands(platform: Platform): InstallCommand[] {
  const port = ATTACH_DEFAULT_PORT
  if (platform === 'windows') {
    return [
      {
        command: `Test-NetConnection 127.0.0.1 -Port ${port}`,
        note: 'TcpTestSucceeded=True 说明端口可连（把 5555 换成候选端口再试）',
      },
      {
        command: 'Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 5555,62001,16384,21503',
        note: '列出常见模拟器监听端口（雷电/夜神/MuMu/MEmu）',
      },
    ]
  }
  if (platform === 'macos') {
    return [
      { command: `lsof -nP -iTCP:${port} -sTCP:LISTEN`, note: '查看 5555 是否被模拟器监听' },
      { command: `nc -z 127.0.0.1 ${port} && echo open`, note: '输出 open 表示 adbd 已就绪' },
    ]
  }
  return [
    {
      command: `ss -ltn | grep -E ':(${ATTACH_COMMON_PORTS.join('|')})$'`,
      note: '列出常见模拟器监听端口（AVD/雷电 5555、夜神 62001、MuMu 16384/16416、MEmu 21503）',
    },
    { command: `nc -z 127.0.0.1 ${port} && echo open`, note: '输出 open 表示 adbd 已就绪' },
  ]
}

export function attachHint(): string {
  return (
    '在「设置 → 手机 → attach.endpoint」填 127.0.0.1:<port>（AVD/雷电常见 5555，夜神 62001，' +
    'MuMu 16384/16416，MEmu 21503）。先用 nc -z 127.0.0.1 5555（Windows: Test-NetConnection）确认端口可达；' +
    '也可把模拟器路径/品牌写进「一句话」让 Agent 解析。真机需自行开启 adb TCP 调试，插件不执行该命令。'
  )
}

/** scrcpy-server jar（视频流/中文输入需要；不影响状态查询与截图）。 */
export const SCRCPY_SECTION: InstallSection = {
  id: 'scrcpy',
  title: '可选：视频流所需的 scrcpy-server（~90KB）',
  commands: [
    {
      command: SCRCPY_FETCH_COMMAND,
      note: '在插件仓库根目录执行；下载并校验 v3.3.3 jar 到 assets/scrcpy-server.jar',
    },
  ],
  notes: [
    '只影响右侧栏视频流与 phone_input_text；phone_status、截图、点击不受影响',
    '#37 合并后视频流会按需自动下载，也可选手工先跑一次',
    '离线环境可用 DSH_PHONE_SCRCPY_SERVER 指向已有 jar（见 docs/install.md §7）',
  ],
}

/* -------------------------------- 组装/渲染 ------------------------------- */

function emulatorSection(platform: Platform): InstallSection {
  return {
    id: 'emulator',
    title: 'Android SDK Emulator（推荐）',
    commands: emulatorCommands(platform),
    notes: ['装好后在设置页选择「Android SDK Emulator」并接受；插件首次调用工具时会 headless 启动。'],
  }
}

function redroidSection(): InstallSection {
  return {
    id: 'redroid',
    title: 'redroid（Linux + Docker）',
    commands: redroidCommands(),
  }
}

function redroidAdvancedSection(): InstallSection {
  return {
    id: 'redroid',
    title: 'redroid（仅 Linux；Windows 需 WSL2，属进阶路径，默认不推荐）',
    commands: [],
    notes: ['WSL2 + redroid 未被本仓库验证，仅作进阶备选；优先用 Android SDK Emulator 或 attach。'],
  }
}

function attachSection(platform: Platform): InstallSection {
  return {
    id: 'attach',
    title: 'attach 已有模拟器/真机（无需安装）',
    commands: attachCommands(platform),
    notes: [attachHint()],
  }
}

/** 平台对应的完整安装指引（结构化，供文本渲染 / JSON 载荷共用）。 */
export function installGuideData(platform: Platform): InstallGuideData {
  const sections: InstallSection[] = []
  if (platform === 'linux') {
    // SPEC §3.1：Linux 首选 redroid
    sections.push(redroidSection(), emulatorSection(platform), attachSection(platform), SCRCPY_SECTION)
  } else if (platform === 'windows' || platform === 'macos') {
    sections.push(emulatorSection(platform), redroidAdvancedSection(), attachSection(platform), SCRCPY_SECTION)
  } else {
    sections.push(attachSection(platform), {
      ...redroidAdvancedSection(),
      title: 'redroid / emulator（当前平台不受支持）',
    }, SCRCPY_SECTION)
  }
  return {
    platform,
    intro: INSTALL_GUIDE_INTRO,
    sections,
    docs: INSTALL_DOCS,
  }
}

/** 把结构化指引渲染成多行文本（命令保持整行可复制）。 */
export function renderInstallGuide(guide: InstallGuideData): string {
  const lines: string[] = [guide.intro]
  guide.sections.forEach((section, index) => {
    lines.push('', `[${index + 1}] ${section.title}`)
    section.commands.forEach((command, commandIndex) => {
      lines.push(`  ${commandIndex + 1}. ${command.command}`)
      if (command.note) lines.push(`     # ${command.note}`)
    })
    for (const note of section.notes ?? []) lines.push(`  # ${note}`)
  })
  lines.push('', `文档：${guide.docs}`)
  return lines.join('\n')
}

/** 文本形态的安装指引（detect/RuntimeUnavailableError.message 用）。 */
export function installGuide(platform: Platform): string {
  return renderInstallGuide(installGuideData(platform))
}

/** 扁平 hints：每行一条命令或短说明，便于工具输出直接复制。 */
export function installGuideHints(platform: Platform): string[] {
  const guide = installGuideData(platform)
  const hints: string[] = [guide.intro]
  for (const section of guide.sections) {
    hints.push('', section.title)
    for (const command of section.commands) {
      hints.push(command.command)
      if (command.note) hints.push(`  # ${command.note}`)
    }
    for (const note of section.notes ?? []) hints.push(`  # ${note}`)
  }
  hints.push('', `文档：${guide.docs}`)
  return hints
}

/** 首次使用守卫的 install 载荷（与三处共用同一数据源，避免文案漂移）。 */
export function createOnboardingInstallPayload(): OnboardingInstallCommands {
  return {
    emulator: {
      commands: emulatorCommands('linux').map((command) => command.command),
      size: ONBOARDING_EMULATOR_SIZE,
    },
    redroid: {
      commands: redroidCommands().map((command) => command.command),
    },
    attach: { hint: attachHint() },
  }
}

/** 客户端引导卡片展示的两条代表命令（同样来自上面的构建器）。 */
export const ONBOARDING_INSTALL_COMMANDS = {
  emulator: emulatorCommands('linux')[0]!.command,
  redroid: redroidCommands()[0]!.command,
} as const
