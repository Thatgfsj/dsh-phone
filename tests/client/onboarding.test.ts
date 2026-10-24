import test from 'node:test'
import assert from 'node:assert/strict'

import { ConfigApiError, createFetchConfigApi, readRunStatus } from '../../src/client/settings-api.ts'
import type { OnboardingState, PhoneConfigView } from '../../src/client/settings-api.ts'
import {
  acceptOnboarding,
  choiceLabelKey,
  declineOnboarding,
  describeOnboarding,
  reopenOnboarding,
} from '../../src/client/onboarding.ts'

function view(
  revision: number,
  onboarding: OnboardingState | undefined,
  userHint = '',
): PhoneConfigView {
  return {
    runtime: 'attach',
    attach: { endpoint: '', userHint, resolved: false },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
    onboarding,
    revision,
  }
}

/** Scriptable ConfigApi: records writes and replays queued outcomes. */
function fakeApi(outcomes: (PhoneConfigView | Error)[]): {
  api: { writeConfig: (path: string[], value: unknown, revision: number) => Promise<PhoneConfigView> }
  calls: { path: string[]; value: unknown; revision: number }[]
} {
  const calls: { path: string[]; value: unknown; revision: number }[] = []
  return {
    calls,
    api: {
      writeConfig: async (path, value, revision) => {
        calls.push({ path, value, revision })
        const outcome = outcomes.shift()
        if (outcome === undefined) throw new Error('unexpected write')
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    },
  }
}

test('describeOnboarding: missing field means accepted (older Hosts)', () => {
  assert.deepEqual(describeOnboarding(undefined), { mode: 'accepted', choice: '', showSetup: true })
  assert.deepEqual(describeOnboarding(view(1, undefined)), {
    mode: 'accepted',
    choice: '',
    showSetup: true,
  })
})

test('describeOnboarding: pending hides setup, accepted shows it, declined hides it', () => {
  const pending = describeOnboarding(view(1, { status: 'pending', choice: '' }))
  assert.deepEqual(pending, { mode: 'pending', choice: '', showSetup: false })
  const accepted = describeOnboarding(view(1, { status: 'accepted', choice: 'redroid' }))
  assert.deepEqual(accepted, { mode: 'accepted', choice: 'redroid', showSetup: true })
  const declined = describeOnboarding(view(1, { status: 'declined', choice: '' }))
  assert.deepEqual(declined, { mode: 'declined', choice: '', showSetup: false })
})

test('choiceLabelKey maps every choice to its i18n key', () => {
  assert.equal(choiceLabelKey('emulator'), 'onboarding.choiceLabel.emulator')
  assert.equal(choiceLabelKey('redroid'), 'onboarding.choiceLabel.redroid')
  assert.equal(choiceLabelKey('attach'), 'onboarding.choiceLabel.attach')
  assert.equal(choiceLabelKey(''), 'onboarding.choiceLabel.none')
})

test('acceptOnboarding writes choice then status, carrying the revision forward', async () => {
  const { api, calls } = fakeApi([view(2, { status: 'pending', choice: '' }), view(3, { status: 'accepted', choice: 'emulator' })])
  const reload = async (): Promise<PhoneConfigView | undefined> => view(1, { status: 'pending', choice: '' })
  const outcome = await acceptOnboarding(api, 'emulator', 1, reload)
  assert.deepEqual(calls, [
    { path: ['onboarding', 'choice'], value: 'emulator', revision: 1 },
    { path: ['onboarding', 'status'], value: 'accepted', revision: 2 },
  ])
  assert.equal(outcome.value.onboarding?.status, 'accepted')
  assert.equal(outcome.retried, false)
})

test('acceptOnboarding refreshes and retries once on a 409 (then carries the new revision)', async () => {
  const { api, calls } = fakeApi([
    new ConfigApiError('E_CONFIG_CONFLICT', 'stale'),
    view(6, { status: 'pending', choice: 'redroid' }),
    view(7, { status: 'accepted', choice: 'redroid' }),
  ])
  const reload = async (): Promise<PhoneConfigView | undefined> => view(5, { status: 'pending', choice: '' })
  const outcome = await acceptOnboarding(api, 'redroid', 1, reload)
  assert.deepEqual(calls, [
    { path: ['onboarding', 'choice'], value: 'redroid', revision: 1 },
    { path: ['onboarding', 'choice'], value: 'redroid', revision: 5 },
    { path: ['onboarding', 'status'], value: 'accepted', revision: 6 },
  ])
  assert.equal(outcome.retried, true)
  assert.equal(outcome.value.onboarding?.status, 'accepted')
})

test('declineOnboarding writes status=declined only', async () => {
  const { api, calls } = fakeApi([view(2, { status: 'declined', choice: '' })])
  const outcome = await declineOnboarding(api, 1, async () => undefined)
  assert.deepEqual(calls, [{ path: ['onboarding', 'status'], value: 'declined', revision: 1 }])
  assert.equal(outcome.value.onboarding?.status, 'declined')
})

test('reopenOnboarding writes status=pending and keeps the choice', async () => {
  const { api, calls } = fakeApi([view(4, { status: 'pending', choice: 'emulator' })])
  const outcome = await reopenOnboarding(api, 3, async () => undefined)
  assert.deepEqual(calls, [{ path: ['onboarding', 'status'], value: 'pending', revision: 3 }])
  assert.equal(outcome.value.onboarding?.status, 'pending')
  assert.equal(outcome.value.onboarding?.choice, 'emulator')
})

test('onboarding writes surface non-conflict failures', async () => {
  const { api } = fakeApi([new ConfigApiError('E_BAD_PATH', 'nope')])
  await assert.rejects(
    () => declineOnboarding(api, 1, async () => undefined),
    (error: unknown) => error instanceof ConfigApiError && error.code === 'E_BAD_PATH',
  )
})

test('createFetchConfigApi parses onboarding from GET /config', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          value: {
            runtime: 'attach',
            attach: { endpoint: '', userHint: '', resolved: false },
            stream: { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
            onboarding: { status: 'pending', choice: '' },
            revision: 9,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    const config = await createFetchConfigApi().getConfig()
    assert.deepEqual(config.onboarding, { status: 'pending', choice: '' })
    assert.equal(config.revision, 9)
  } finally {
    globalThis.fetch = original
  }
})

test('readRunStatus tolerates the pending 200/ok:false guard but rethrows real errors', async () => {
  const guarded = {
    getStatus: async () => {
      throw new ConfigApiError('E_ONBOARDING_REQUIRED', 'confirm onboarding first')
    },
  }
  assert.equal(await readRunStatus(guarded), undefined)

  const unavailable = {
    getStatus: async () => {
      throw new ConfigApiError('E_RUNTIME_UNAVAILABLE', 'no runtime')
    },
  }
  assert.equal(await readRunStatus(unavailable), undefined)

  const auth = {
    getStatus: async () => {
      throw new ConfigApiError('E_AUTH', 'unauthorized')
    },
  }
  await assert.rejects(() => readRunStatus(auth), (error: unknown) => error instanceof ConfigApiError && error.code === 'E_AUTH')
})

test('POST /config sends {path,value,revision} for onboarding keys', async () => {
  const original = globalThis.fetch
  const seen: { url: string; init?: RequestInit }[] = []
  try {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(
        JSON.stringify({ ok: true, value: view(12, { status: 'accepted', choice: 'attach' }) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    const api = createFetchConfigApi()
    const next = await api.writeConfig(['onboarding', 'status'], 'accepted', 11)
    assert.equal(next.onboarding?.status, 'accepted')
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.url, '/dsh-phone/api/config')
    assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)), {
      path: ['onboarding', 'status'],
      value: 'accepted',
      revision: 11,
    })
  } finally {
    globalThis.fetch = original
  }
})
