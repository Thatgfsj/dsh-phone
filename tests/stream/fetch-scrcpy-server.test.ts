import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_DEST,
  DEFAULT_MIRRORS,
  parseArgs,
  SCRCPY_VERSION,
  SERVER_ASSET,
  SERVER_SHA256,
  SERVER_URL,
  sha256Hex,
  verifyFile,
} from '../../scripts/fetch-scrcpy-server.mjs'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/fetch-scrcpy-server.mjs')

test('固定版本、官方 URL、sha256 形状', () => {
  assert.equal(SCRCPY_VERSION, '3.3.3')
  assert.equal(SERVER_ASSET, 'scrcpy-server-v3.3.3')
  assert.equal(
    SERVER_URL,
    'https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3',
  )
  assert.match(SERVER_SHA256, /^[0-9a-f]{64}$/)
  assert.ok(DEFAULT_DEST.endsWith(join('assets', 'scrcpy-server.jar')))
  assert.ok(DEFAULT_MIRRORS.length >= 1)
})

test('sha256Hex 与官方测试向量一致', () => {
  assert.equal(
    sha256Hex(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('verifyFile：命中、缺失、不匹配', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-phone-scrcpy-'))
  try {
    const file = join(dir, 'server.jar')
    await writeFile(file, Buffer.from('payload'))
    const expected = sha256Hex(Buffer.from('payload'))
    assert.deepEqual(await verifyFile(file, expected), {
      ok: true,
      actual: expected,
      size: 7,
      missing: false,
    })
    const wrong = await verifyFile(file, SERVER_SHA256)
    assert.equal(wrong.ok, false)
    assert.equal(wrong.missing, false)
    assert.equal((await verifyFile(join(dir, 'absent.jar'))).missing, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseArgs：--check/--force/--out/--mirror，非法参数报错', () => {
  assert.deepEqual(parseArgs(['--check']), {
    check: true,
    force: false,
    destination: DEFAULT_DEST,
    mirrors: [],
  })
  const options = parseArgs(['--force', '--out', 'tmp/x.jar', '--mirror', 'https://m.example'])
  assert.equal(options.force, true)
  assert.ok(options.destination.endsWith('x.jar'))
  assert.deepEqual(options.mirrors, ['https://m.example/'])
  assert.throws(() => parseArgs(['--wat']), /未知参数/)
})

test('CLI --check 对缺失/伪造文件返回非零', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-phone-scrcpy-cli-'))
  try {
    const missing = spawnSync(process.execPath, [SCRIPT, '--check', '--out', join(dir, 'none.jar')], {
      encoding: 'utf8',
    })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /缺少/)

    const fake = join(dir, 'fake.jar')
    await writeFile(fake, Buffer.from('not scrcpy'))
    const mismatch = spawnSync(process.execPath, [SCRIPT, '--check', '--out', fake], {
      encoding: 'utf8',
    })
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /sha256 不匹配/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CLI --help 输出许可与 sha256', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Apache-2\.0/)
  assert.match(help.stdout, /3\.3\.3/)
})
