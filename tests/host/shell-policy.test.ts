import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DUMPSYS_READONLY_SERVICES,
  SHELL_WHITELIST_SUMMARY,
  evaluateShellCommand,
  isWhitelistedShellCommand,
  registerShellApproval,
} from '../../src/tools/shell-policy.ts'
import type { ShellApprovalExec, ShellApprovalHost, ShellApprovalNext } from '../../src/tools/shell-policy.ts'

test('白名单：getprop / wm size / dumpsys 只读子集免确认', () => {
  assert.ok(isWhitelistedShellCommand('getprop'))
  assert.ok(isWhitelistedShellCommand('  getprop ro.product.model  '))
  assert.ok(isWhitelistedShellCommand('wm size'))
  assert.ok(isWhitelistedShellCommand('dumpsys activity'))
  assert.ok(isWhitelistedShellCommand('dumpsys meminfo com.example.app'))
  assert.equal(evaluateShellCommand('getprop ro.product.model').kind, 'allow')
})

test('非白名单：写操作/高危命令一律 ask', () => {
  for (const command of [
    'input tap 100 200',
    'rm -rf /sdcard',
    'pm install /sdcard/x.apk',
    'wm size 720x1280',
    'dumpsys',
    'dumpsys activity; rm -rf /sdcard',
    'getprop | grep model',
    'getprop && reboot',
    'getprop \u0060reboot\u0060',
  ]) {
    assert.equal(isWhitelistedShellCommand(command), false, command)
    const decision = evaluateShellCommand(command)
    assert.equal(decision.kind, 'ask', command)
    if (decision.kind === 'ask') {
      assert.match(decision.reason, /phone_shell/)
      assert.equal(typeof decision.displayReason.en, 'string')
      assert.equal(typeof decision.displayReason.zh, 'string')
    }
  }
})

test('dumpsys 只要求读 service 在子集内', () => {
  for (const service of DUMPSYS_READONLY_SERVICES) {
    assert.ok(isWhitelistedShellCommand('dumpsys ' + service), service)
  }
  assert.equal(isWhitelistedShellCommand('dumpsys package'), false)
  assert.equal(isWhitelistedShellCommand('dumpsys surfaceflinger'), false)
})

test('空命令/超长命令不白名单', () => {
  assert.equal(isWhitelistedShellCommand(''), false)
  assert.equal(isWhitelistedShellCommand('   '), false)
  assert.equal(isWhitelistedShellCommand('getprop ' + 'a'.repeat(600)), false)
})

test('白名单摘要包含三类命令（工具描述复用）', () => {
  assert.match(SHELL_WHITELIST_SUMMARY, /getprop/)
  assert.match(SHELL_WHITELIST_SUMMARY, /wm size/)
  assert.match(SHELL_WHITELIST_SUMMARY, /dumpsys/)
})
test('注册级：registerShellApproval 在 tools/pre-execute 上接线 ask / next', async () => {
  let listener:
    | ((exec: ShellApprovalExec, next: ShellApprovalNext) => Promise<unknown>)
    | undefined
  const events: string[] = []
  const host: ShellApprovalHost = {
    on(event, handler) {
      events.push(event)
      listener = handler
      return () => undefined
    },
  }
  registerShellApproval(host)
  assert.deepEqual(events, ['tools/pre-execute'])
  assert.ok(listener)

  let nextCalls = 0
  const next: ShellApprovalNext = async () => {
    nextCalls += 1
    return { kind: 'allow' }
  }

  // 非 phone_shell：原样 next
  await listener!({ name: 'phone_tap', arguments: { x: 1, y: 2 } }, next)
  assert.equal(nextCalls, 1)

  // 白名单 phone_shell：next 放行
  await listener!({ name: 'phone_shell', arguments: { cmd: 'getprop ro.product.model' } }, next)
  assert.equal(nextCalls, 2)

  // 非白名单 phone_shell：ask，不调用 next
  const decision = (await listener!(
    { name: 'phone_shell', arguments: { cmd: 'rm -rf /sdcard' } },
    next,
  )) as { kind: string; reason: string; displayReason: { en: string; zh: string } }
  assert.equal(decision.kind, 'ask')
  assert.equal(nextCalls, 2)
  assert.match(decision.reason, /phone_shell/)
  assert.ok(decision.displayReason.en.length > 0)
  assert.ok(decision.displayReason.zh.length > 0)
})
