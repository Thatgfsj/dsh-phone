/**
 * 本地 Agent 通道凭据（SPEC §5.2 步骤 6 的宿主侧补位）。
 *
 * 背景：操作 Agent 只有 shell/文件工具，拿不到浏览器 cookie，无法调用依赖
 * `ctx.connection` 同源鉴权的 POST /dsh-phone/api/config。因此 apply 时生成
 * 32 字节随机 token 写入 `$DSH_HOME/storages/dsh-phone/agent.json`（0600），
 * 并额外提供 POST /dsh-phone/api/agent/config：
 * - 仅 loopback（127/8、::1、::ffff:127.x）；
 * - 无 Origin 头；
 * - `x-dsh-phone-token` 与文件 token 常量时间相等。
 * 满足三者才绕过浏览器同源校验，其余情况仍走 ctx.connection.requestRejection。
 *
 * 插件卸载时删除 token 文件（重新加载会生成新 token）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const AGENT_TOKEN_HEADER = 'x-dsh-phone-token'
export const AGENT_TOKEN_FILE_NAME = 'agent.json'

export interface AgentTokenFile {
  token: string
  baseUrl: string
}

/** 解析 token 文件路径：`$DSH_HOME/storages/dsh-phone/agent.json`（空 DSH_HOME 视为未设置）。 */
export function resolveAgentTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-phone', AGENT_TOKEN_FILE_NAME)
}

/** 生成 32 字节十六进制 token（64 字符）。 */
export function generateAgentToken(): string {
  return randomBytes(32).toString('hex')
}

/** loopback 判定：127/8、::1、::ffff:127/8（含 IPv6 映射形式）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const value = address.trim().toLowerCase()
  if (value === '::1' || value === 'localhost') return true
  const mapped = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
  const parts = mapped.split('.')
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const first = Number(parts[0])
    return first === 127 && parts.every((part) => Number(part) <= 255)
  }
  return false
}

/** 请求头读取（IncomingMessage.headers 是唯一的来源）。 */
function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name]
  if (Array.isArray(raw)) return raw[0]
  return raw
}

export class AgentTokenStore {
  readonly filePath: string
  #token: string | undefined
  #baseUrl = ''
  #prepared: Promise<void> | undefined

  constructor(options: { env?: NodeJS.ProcessEnv; filePath?: string } = {}) {
    this.filePath = options.filePath ?? resolveAgentTokenPath(options.env)
  }

  get info(): AgentTokenFile | undefined {
    if (!this.#token) return undefined
    return { token: this.#token, baseUrl: this.#baseUrl }
  }

  /** 生成并落盘 token；幂等（并发/重复调用复用同一 promise）。 */
  prepare(baseUrl: string): Promise<void> {
    this.#baseUrl = baseUrl
    this.#prepared ??= (async () => {
      const token = generateAgentToken()
      const directory = dirname(this.filePath)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(this.filePath, JSON.stringify({ token, baseUrl }, null, 2) + '\n', {
        mode: 0o600,
      })
      await chmod(this.filePath, 0o600).catch(() => undefined)
      this.#token = token
    })()
    return this.#prepared
  }

  /** 校验请求：loopback + 无 Origin + header token 常量时间相等。 */
  async verifyRequest(request: {
    socket?: { remoteAddress?: string | undefined }
    headers: Record<string, string | string[] | undefined>
  }): Promise<boolean> {
    await this.#prepared?.catch(() => undefined)
    const token = this.#token
    if (!token) return false
    if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
    if (headerValue(request.headers, 'origin') !== undefined) return false
    const candidate = headerValue(request.headers, AGENT_TOKEN_HEADER)
    if (typeof candidate !== 'string' || candidate.length === 0) return false
    const left = Buffer.from(candidate, 'utf8')
    const right = Buffer.from(token, 'utf8')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }

  /** 读取落盘 token（诊断/测试用；不存在时返回 undefined）。 */
  async readFile(): Promise<AgentTokenFile | undefined> {
    try {
      const text = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(text) as Partial<AgentTokenFile>
      if (typeof parsed.token !== 'string' || typeof parsed.baseUrl !== 'string') return undefined
      return { token: parsed.token, baseUrl: parsed.baseUrl }
    } catch {
      return undefined
    }
  }

  /** 插件卸载清理：删除 token 文件（不影响其它 profile 数据）。 */
  async dispose(): Promise<void> {
    await rm(this.filePath, { force: true }).catch(() => undefined)
  }
}
