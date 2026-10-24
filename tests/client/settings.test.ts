import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ConfigApiError,
  canEditConfig,
  createFetchConfigApi,
  describeEnabled,
  messageOf,
  writeWithConflictRetry,
} from '../../src/client/settings-api.ts'
import type { ConfigApi, PhoneConfigView } from '../../src/client/settings-api.ts'

function config(revision: number, userHint = ''): PhoneConfigView {
  return {
    runtime: 'attach',
    attach: { endpoint: '', userHint, resolved: false },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
    revision,
  }
}

/** Scriptable ConfigApi: records calls and replays queued outcomes. */
function fakeApi(outcomes: (PhoneConfigView | Error)[]): {
  api: ConfigApi
  calls: { revision: number; value: unknown }[]
} {
  const calls: { revision: number; value: unknown }[] = []
  return {
    calls,
    api: {
      getConfig: async () => config(1),
      getStatus: async () => ({ state: 'stopped', runtime: 'attach' }),
      writeConfig: async (_path, value, revision) => {
        calls.push({ revision, value })
        const outcome = outcomes.shift()
        if (outcome === undefined) throw new Error('unexpected write')
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    },
  }
}

test('writeWithConflictRetry writes once when the revision matches', async () => {
  const { api, calls } = fakeApi([config(2, '雷电模拟器')])
  const outcome = await writeWithConflictRetry(api, ['attach', 'userHint'], '雷电模拟器', 1, async () => config(1))
  assert.equal(outcome.retried, false)
  assert.equal(outcome.value.revision, 2)
  assert.deepEqual(calls, [{ revision: 1, value: '雷电模拟器' }])
})

test('writeWithConflictRetry refreshes and retries exactly once on 409', async () => {
  const { api, calls } = fakeApi([
    new ConfigApiError('E_CONFIG_CONFLICT', 'stale revision'),
    config(3, '夜神'),
  ])
  const reloads: number[] = []
  const outcome = await writeWithConflictRetry(api, ['attach', 'userHint'], '夜神', 1, async () => {
    reloads.push(1)
    return config(2)
  })
  assert.equal(outcome.retried, true)
  assert.equal(outcome.value.revision, 3)
  assert.deepEqual(calls, [
    { revision: 1, value: '夜神' },
    { revision: 2, value: '夜神' },
  ])
  assert.equal(reloads.length, 1)
})

test('writeWithConflictRetry surfaces a second conflict instead of looping', async () => {
  const { api, calls } = fakeApi([
    new ConfigApiError('E_CONFIG_CONFLICT', 'stale'),
    new ConfigApiError('E_CONFIG_CONFLICT', 'still stale'),
  ])
  await assert.rejects(
    () => writeWithConflictRetry(api, ['attach', 'resolved'], false, 1, async () => config(2)),
    (error: unknown) => error instanceof ConfigApiError && error.code === 'E_CONFIG_CONFLICT',
  )
  assert.equal(calls.length, 2)
})

test('writeWithConflictRetry propagates non-conflict failures untouched', async () => {
  const { api } = fakeApi([new ConfigApiError('E_BAD_PATH', 'nope')])
  await assert.rejects(
    () => writeWithConflictRetry(api, [], true, 1, async () => config(2)),
    (error: unknown) => error instanceof ConfigApiError && error.code === 'E_BAD_PATH',
  )
})

test('request envelope parsing throws protocol-coded errors', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error: { code: 'E_CONFIG_CONFLICT', message: 'stale' } }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    const api = createFetchConfigApi()
    await assert.rejects(
      () => api.writeConfig(['attach', 'resolved'], false, 7),
      (error: unknown) => error instanceof ConfigApiError && error.code === 'E_CONFIG_CONFLICT',
    )
    assert.equal(messageOf(new Error('boom')), 'boom')
    assert.equal(messageOf(42), '42')
  } finally {
    globalThis.fetch = original
  }
})


test('describeEnabled maps the optional Host flag to three display states', () => {
  assert.equal(describeEnabled(true), 'enabled')
  assert.equal(describeEnabled(false), 'disabled')
  assert.equal(describeEnabled(undefined), 'unknown')
})

test('canEditConfig hides every write path only when the plugin is disabled', () => {
  assert.equal(canEditConfig(true), true)
  assert.equal(canEditConfig(undefined), true, 'older Hosts keep the editable UI')
  assert.equal(canEditConfig(false), false)
})
