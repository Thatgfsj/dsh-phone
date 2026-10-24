/**
 * 宿主命令执行器（docker CLI / emulator 等）。
 *
 * 只负责 `child_process` 封装与错误归一化；单测通过注入假的
 * {@link CommandRunner} 替代，不依赖宿主机装没装 docker/emulator。
 */

import { execFile, spawn } from 'node:child_process'

import type {
  CommandResult,
  CommandRunOptions,
  CommandRunner,
  KillSignal,
  SpawnDetachedOptions,
  SpawnedProcess,
} from './types.ts'

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

function asText(value: string | Buffer | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : value.toString('utf8')
}

function runCommand(
  file: string,
  args: readonly string[],
  options: CommandRunOptions = {},
): Promise<CommandResult> {
  const env = options.env ? { ...process.env, ...options.env } : process.env
  return new Promise<CommandResult>((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        cwd: options.cwd,
        env,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        const failure = error as
          | { code?: number | string; killed?: boolean; signal?: string }
          | null
        let code: number | null = 0
        if (failure) {
          code = typeof failure.code === 'number' ? failure.code : null
        }
        resolve({
          code,
          stdout: asText(stdout),
          stderr: asText(stderr),
          timedOut: Boolean(failure?.killed),
        })
      },
    )
  })
}

function spawnDetached(
  file: string,
  args: readonly string[],
  options: SpawnDetachedOptions = {},
): Promise<SpawnedProcess> {
  const env = options.env ? { ...process.env, ...options.env } : process.env
  return new Promise<SpawnedProcess>((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    // detached 子进程不阻塞事件循环，也不让父进程收到它的退出码
    child.unref()
    if (!settled) {
      settled = true
      resolve({ pid: child.pid })
    }
  })
}

export function createCommandRunner(): CommandRunner {
  return {
    run: runCommand,
    spawnDetached,

    async kill(pid: number, signal: KillSignal = 'SIGTERM'): Promise<boolean> {
      try {
        process.kill(pid, signal)
        return true
      } catch {
        return false
      }
    },

    async isProcessAlive(pid: number): Promise<boolean> {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM 说明进程存在但无权限（不会发生在本进程的子进程上）
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
  }
}
