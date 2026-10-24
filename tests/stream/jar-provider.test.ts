import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { sha256Hex } from '../../scripts/fetch-scrcpy-server.mjs'
import {
  defaultServerJarPath,
  MANUAL_FETCH_COMMAND,
  ScrcpyServerJarProvider,
  ScrcpyServerUnavailableError,
  SERVER_JAR_ENV,
  serverJarPath,
} from '../../src/stream/jar-provider.ts'

const PAYLOAD = new TextEncoder().encode('fake scrcpy server jar payload')
const PAYLOAD_SHA = sha256Hex(Buffer.from(PAYLOAD))

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-phone-jar-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function withEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[SERVER_JAR_ENV]
  if (value === undefined) delete process.env[SERVER_JAR_ENV]
  else process.env[SERVER_JAR_ENV] = value
  return fn().finally(() => {
    if (previous === undefined) delete process.env[SERVER_JAR_ENV]
    else process.env[SERVER_JAR_ENV] = previous
  })
}

test('默认路径固定在 assets/scrcpy-server.jar；环境变量可覆盖', async () => {
  assert.ok(defaultServerJarPath().endsWith(join('assets', 'scrcpy-server.jar')))
  await withEnv(undefined, async () => {
    assert.equal(serverJarPath(), defaultServerJarPath())
  })
  await withEnv('/tmp/custom-scrcpy.jar', async () => {
    assert.equal(serverJarPath(), '/tmp/custom-scrcpy.jar')
  })
})

test('已存在且 sha256 通过：不触发下载', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'scrcpy-server.jar')
    await writeFile(path, PAYLOAD)
    let downloads = 0
    const provider = new ScrcpyServerJarProvider({
      path,
      expectedSha256: PAYLOAD_SHA,
      downloader: async () => {
        downloads += 1
      },
    })
    assert.equal(await provider.ensure(), path)
    assert.equal(downloads, 0)
  })
})

test('缺失时懒下载成功并校验通过', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'assets', 'scrcpy-server.jar')
    let downloads = 0
    const provider = new ScrcpyServerJarProvider({
      path,
      expectedSha256: PAYLOAD_SHA,
      downloader: async (destination: string) => {
        downloads += 1
        await writeFile(destination, PAYLOAD).catch(async () => {
          const { mkdir } = await import('node:fs/promises')
          await mkdir(join(dir, 'assets'), { recursive: true })
          await writeFile(destination, PAYLOAD)
        })
      },
    })
    assert.equal(await provider.ensure(), path)
    assert.equal(downloads, 1)
    assert.deepEqual(new Uint8Array(await readFile(path)), PAYLOAD)
  })
})

test('下载成功但 sha256 不匹配：结构化错误 + 删除坏文件', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'scrcpy-server.jar')
    const provider = new ScrcpyServerJarProvider({
      path,
      expectedSha256: PAYLOAD_SHA,
      downloader: async (destination: string) => {
        await writeFile(destination, 'corrupted')
      },
    })
    await assert.rejects(provider.ensure(), (error: unknown) => {
      assert.ok(error instanceof ScrcpyServerUnavailableError)
      assert.equal(error.code, 'E_SCRCPY_SERVER_UNAVAILABLE')
      assert.equal(error.retryable, true)
      assert.equal(error.manualCommand, MANUAL_FETCH_COMMAND)
      assert.match(error.message, /sha256 校验失败/)
      return true
    })
    await assert.rejects(stat(path), /ENOENT/)
  })
})

test('下载器抛错：结构化错误含手工命令，可重试', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'scrcpy-server.jar')
    let downloads = 0
    const provider = new ScrcpyServerJarProvider({
      path,
      expectedSha256: PAYLOAD_SHA,
      downloader: async () => {
        downloads += 1
        if (downloads === 1) throw new Error('HTTP 500 from GitHub')
        await writeFile(path, PAYLOAD)
      },
    })
    await assert.rejects(provider.ensure(), (error: unknown) => {
      assert.ok(error instanceof ScrcpyServerUnavailableError)
      assert.equal(error.code, 'E_SCRCPY_SERVER_UNAVAILABLE')
      assert.equal(error.retryable, true)
      assert.match(error.message, /HTTP 500/)
      assert.match(error.message, new RegExp(MANUAL_FETCH_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    })
    // 失败后 in-flight 已清除，可重试成功
    assert.equal(await provider.ensure(), path)
    assert.equal(downloads, 2)
  })
})

test('下载超时：E_SCRCPY_SERVER_TIMEOUT，可重试', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'scrcpy-server.jar')
    let attempt = 0
    const provider = new ScrcpyServerJarProvider({
      path,
      expectedSha256: PAYLOAD_SHA,
      timeoutMs: 20,
      downloader: async (destination: string) => {
        attempt += 1
        if (attempt === 1) return new Promise<void>(() => {})
        await writeFile(destination, PAYLOAD)
      },
    })
    await assert.rejects(provider.ensure(), (error: unknown) => {
      assert.ok(error instanceof ScrcpyServerUnavailableError)
      assert.equal(error.code, 'E_SCRCPY_SERVER_TIMEOUT')
      assert.equal(error.retryable, true)
      assert.match(error.message, /超时/)
      return true
    })
    assert.equal(await provider.ensure(), path)
  })
})

test('并发 ensure single-flight：只下载一次', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'scrcpy-server.jar')
    let downloads = 0
    const provider = new ScrcpyServerJarProvider({
      path,
      expectedSha256: PAYLOAD_SHA,
      downloader: async (destination: string) => {
        downloads += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        await writeFile(destination, PAYLOAD)
      },
    })
    const [a, b] = await Promise.all([provider.ensure(), provider.ensure()])
    assert.equal(a, path)
    assert.equal(b, path)
    assert.equal(downloads, 1)
  })
})

test('环境变量覆盖：缺失时报错且不自动下载；存在时直接使用', async () => {
  await withTempDir(async (dir) => {
    const missing = join(dir, 'custom.jar')
    await withEnv(missing, async () => {
      const provider = new ScrcpyServerJarProvider()
      await assert.rejects(provider.ensure(), (error: unknown) => {
        assert.ok(error instanceof ScrcpyServerUnavailableError)
        assert.equal(error.retryable, false)
        assert.match(error.message, new RegExp(SERVER_JAR_ENV))
        return true
      })
    })
    await writeFile(missing, PAYLOAD)
    await withEnv(missing, async () => {
      const provider = new ScrcpyServerJarProvider({ expectedSha256: PAYLOAD_SHA })
      assert.equal(await provider.ensure(), missing)
    })
  })
})
