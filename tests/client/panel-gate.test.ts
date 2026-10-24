import test from 'node:test'
import assert from 'node:assert/strict'

import { describeEmptyState } from '../../src/client/empty-state.ts'
import { describePanelGate, loadPanelConfig } from '../../src/client/gate.ts'
import type { PhoneConfigView } from '../../src/client/settings-api.ts'

const t = (key: string, vars?: Readonly<Record<string, string | number>>): string =>
  vars === undefined ? key : key + ':' + String(vars.message ?? '')

function view(onboarding?: { status: 'pending' | 'accepted' | 'declined'; choice: '' }): PhoneConfigView {
  return {
    runtime: 'attach',
    attach: { endpoint: '', userHint: '', resolved: false },
    stream: { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
    onboarding,
    revision: 1,
  }
}

test('describePanelGate: loading, error, pending, declined, ready', () => {
  assert.equal(describePanelGate({}), 'checking')
  assert.equal(describePanelGate({ config: view(), error: new Error('offline') }), 'unavailable')
  assert.equal(describePanelGate({ config: view({ status: 'pending', choice: '' }) }), 'pending')
  assert.equal(describePanelGate({ config: view({ status: 'declined', choice: '' }) }), 'declined')
  assert.equal(describePanelGate({ config: view({ status: 'accepted', choice: '' }) }), 'ready')
  assert.equal(describePanelGate({ config: view(undefined) }), 'ready', 'older Host without onboarding')
})

test('describeEmptyState: pending asks for confirmation and embeds the card action', () => {
  const copy = describeEmptyState('pending', t)
  assert.equal(copy.title, 'panel.empty.pendingTitle')
  assert.equal(copy.body, 'panel.empty.pendingBody')
  assert.equal(copy.hint, 'panel.empty.settingsHint')
  assert.equal(copy.action, 'enable')
})

test('describeEmptyState: declined explains paused state', () => {
  const copy = describeEmptyState('declined', t)
  assert.equal(copy.title, 'panel.empty.declinedTitle')
  assert.equal(copy.body, 'panel.empty.declinedBody')
  assert.equal(copy.action, 'enable')
})

test('describeEmptyState: unavailable carries the host error and offers retry', () => {
  const copy = describeEmptyState('unavailable', t, 'HTTP 503')
  assert.equal(copy.title, 'panel.empty.unavailableTitle')
  assert.equal(copy.body, 'panel.empty.unavailableBody:HTTP 503')
  assert.equal(copy.hint, 'panel.empty.unavailableHint')
  assert.equal(copy.action, 'retry')
})

test('loadPanelConfig returns the first successful read without sleeping', async () => {
  let loads = 0
  let sleeps = 0
  const result = await loadPanelConfig({
    getConfig: async () => {
      loads += 1
      return view()
    },
    sleep: async () => {
      sleeps += 1
    },
  })
  assert.equal(result.config?.runtime, 'attach')
  assert.equal(result.error, undefined)
  assert.equal(loads, 1)
  assert.equal(sleeps, 0)
})

test('loadPanelConfig retries transient failures so the first frame is not an error', async () => {
  let loads = 0
  let sleeps = 0
  const result = await loadPanelConfig({
    getConfig: async () => {
      loads += 1
      if (loads < 3) throw new Error('host booting')
      return view({ status: 'pending', choice: '' })
    },
    sleep: async () => {
      sleeps += 1
    },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.config?.onboarding?.status, 'pending')
  assert.equal(loads, 3)
  assert.equal(sleeps, 2)
})

test('loadPanelConfig gives up with the last error after all attempts', async () => {
  let loads = 0
  let sleeps = 0
  const result = await loadPanelConfig({
    getConfig: async () => {
      loads += 1
      throw new Error('still down')
    },
    sleep: async () => {
      sleeps += 1
    },
  })
  assert.equal(result.config, undefined)
  assert.equal((result.error as Error).message, 'still down')
  assert.equal(loads, 4)
  assert.equal(sleeps, 3)
})