import test from 'node:test'
import assert from 'node:assert/strict'

import { maybeAutoOpenPhone } from '../../src/client/auto-open.ts'

interface Clock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  elapsed: () => number
}

function clock(): Clock {
  let current = 0
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms
    },
    elapsed: () => current,
  }
}

function config(onboarding: { status: string } | undefined) {
  return onboarding === undefined ? {} : { onboarding }
}

test('auto-open opens the tab once when onboarding is accepted', async () => {
  const c = clock()
  let attempts = 0
  const result = await maybeAutoOpenPhone({
    getConfig: async () => config({ status: 'accepted' }),
    openTab: () => {
      attempts += 1
    },
    now: c.now,
    sleep: c.sleep,
  })
  assert.equal(result, 'opened')
  assert.equal(attempts, 1)
})

test('auto-open skips pending and declined onboarding without touching the sidebar', async () => {
  for (const status of ['pending', 'declined']) {
    const c = clock()
    let attempts = 0
    const result = await maybeAutoOpenPhone({
      getConfig: async () => config({ status }),
      openTab: () => {
        attempts += 1
      },
      now: c.now,
      sleep: c.sleep,
    })
    assert.equal(result, 'skipped')
    assert.equal(attempts, 0)
  }
})

test('auto-open treats a Host without the onboarding field as accepted', async () => {
  const c = clock()
  const result = await maybeAutoOpenPhone({
    getConfig: async () => config(undefined),
    openTab: () => {},
    now: c.now,
    sleep: c.sleep,
  })
  assert.equal(result, 'opened')
})

test('auto-open retries while the shell has no adopted session yet', async () => {
  const c = clock()
  let attempts = 0
  const result = await maybeAutoOpenPhone({
    getConfig: async () => config({ status: 'accepted' }),
    openTab: () => {
      attempts += 1
      if (attempts < 3) throw new Error('no session on screen')
    },
    now: c.now,
    sleep: c.sleep,
  })
  assert.equal(result, 'opened')
  assert.equal(attempts, 3)
  assert.equal(c.elapsed(), 1000, 'two 500ms polls')
})

test('auto-open gives up after the 10s window without throwing', async () => {
  const c = clock()
  let attempts = 0
  const result = await maybeAutoOpenPhone({
    getConfig: async () => config({ status: 'accepted' }),
    openTab: () => {
      attempts += 1
      throw new Error('still no session')
    },
    now: c.now,
    sleep: c.sleep,
  })
  assert.equal(result, 'timeout')
  assert.equal(c.elapsed(), 10_000)
  assert.equal(attempts, 21, 'attempt at 0,500,...,10000ms then stop')
})

test('auto-open reports unavailable instead of throwing when config cannot be read', async () => {
  const c = clock()
  let attempts = 0
  const result = await maybeAutoOpenPhone({
    getConfig: async () => {
      throw new Error('host down')
    },
    openTab: () => {
      attempts += 1
    },
    now: c.now,
    sleep: c.sleep,
  })
  assert.equal(result, 'unavailable')
  assert.equal(attempts, 0)
})
