import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ONBOARDING_DOCS,
  ONBOARDING_INSTALL,
  ONBOARDING_OPTIONS,
  effectiveRuntime,
  isOnboardingChoice,
  isOnboardingStatus,
  normalizeOnboardingState,
  onboardingFailure,
} from '../../src/config/onboarding.ts'

test('onboardingFailure：pending → E_ONBOARDING_REQUIRED（consent + options/install/docs）', () => {
  const failure = onboardingFailure({ status: 'pending', choice: '' })
  assert.ok(failure)
  assert.equal(failure.code, 'E_ONBOARDING_REQUIRED')
  assert.equal(failure.retryable, false)
  const payload = failure.onboarding as Record<string, unknown>
  assert.equal(payload.step, 'consent')
  assert.equal(payload.docs, ONBOARDING_DOCS)
  assert.deepEqual(
    ONBOARDING_OPTIONS.map((option) => option.id),
    ['emulator', 'redroid', 'attach', 'decline'],
  )
  assert.deepEqual(ONBOARDING_INSTALL.emulator.size, '~1.7GB')
  assert.ok(ONBOARDING_INSTALL.emulator.commands.length > 0)
  assert.ok(ONBOARDING_INSTALL.redroid.commands.length > 0)
  assert.equal(typeof ONBOARDING_INSTALL.attach.hint, 'string')
})

test('onboardingFailure：pending 且已预选 choice → step=choose-runtime', () => {
  const failure = onboardingFailure({ status: 'pending', choice: 'emulator' })
  assert.equal((failure?.onboarding as Record<string, unknown>).step, 'choose-runtime')
})

test('onboardingFailure：accepted 放行；declined → E_ONBOARDING_DECLINED', () => {
  assert.equal(onboardingFailure({ status: 'accepted', choice: '' }), undefined)
  assert.equal(onboardingFailure({ status: 'accepted', choice: 'attach' }), undefined)
  const declined = onboardingFailure({ status: 'declined', choice: 'attach' })
  assert.equal(declined?.code, 'E_ONBOARDING_DECLINED')
  assert.equal(declined?.retryable, false)
  assert.match(declined?.message ?? '', /设置页/)
})

test('effectiveRuntime：accepted+choice 显式覆盖；否则沿用原 runtime', () => {
  assert.equal(effectiveRuntime('auto', { status: 'accepted', choice: 'emulator' }), 'emulator')
  assert.equal(effectiveRuntime('auto', { status: 'accepted', choice: 'redroid' }), 'redroid')
  assert.equal(effectiveRuntime('attach', { status: 'accepted', choice: 'attach' }), 'attach')
  assert.equal(effectiveRuntime('auto', { status: 'accepted', choice: '' }), 'auto')
  assert.equal(effectiveRuntime('emulator', { status: 'accepted', choice: '' }), 'emulator')
  assert.equal(effectiveRuntime('auto', { status: 'pending', choice: 'emulator' }), 'auto')
  assert.equal(effectiveRuntime('auto', { status: 'declined', choice: 'redroid' }), 'auto')
})

test('normalizeOnboardingState：旧配置/非法值 → pending；合法值保留', () => {
  assert.deepEqual(normalizeOnboardingState(undefined), { status: 'pending', choice: '' })
  assert.deepEqual(normalizeOnboardingState(null), { status: 'pending', choice: '' })
  assert.deepEqual(normalizeOnboardingState({}), { status: 'pending', choice: '' })
  assert.deepEqual(normalizeOnboardingState({ status: 'bogus', choice: 'bogus' }), {
    status: 'pending',
    choice: '',
  })
  assert.deepEqual(normalizeOnboardingState({ status: 'accepted', choice: 'redroid' }), {
    status: 'accepted',
    choice: 'redroid',
  })
  assert.ok(isOnboardingStatus('accepted'))
  assert.equal(isOnboardingStatus('nope'), false)
  assert.ok(isOnboardingChoice('attach'))
  assert.ok(isOnboardingChoice(''))
  assert.equal(isOnboardingChoice('waydroid'), false)
})