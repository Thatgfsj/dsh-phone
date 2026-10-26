import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ActionApiError,
  actionErrorKey,
  actionErrorKind,
  createFetchActionApi,
  isAppDrawerUnavailable,
} from '../../src/client/action-api.ts'
import { createPanelFooter } from '../../src/client/panel-footer.ts'
import { describePanelLayout } from '../../src/client/layout.ts'

const t = (key: string, vars?: Readonly<Record<string, string | number>>): string =>
  vars === undefined ? key : key + ':' + String(vars.message ?? '')

interface FakeElement {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}

/** Minimal createElement fake: the footer uses no hooks. */
function fakeReact() {
  return {
    createElement(type: unknown, props?: unknown, ...children: unknown[]): FakeElement {
      return { type: String(type), props: (props ?? {}) as Record<string, unknown>, children }
    },
  }
}

function walk(node: unknown, visit: (element: FakeElement) => void): void {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const element = node as FakeElement
  if (typeof element.type === 'string') visit(element)
  for (const child of element.children ?? []) walk(child, visit)
}

function footer(props: Record<string, unknown>): FakeElement {
  const Footer = createPanelFooter({ React: fakeReact() as never, t })
  return (Footer as unknown as (p: Record<string, unknown>) => FakeElement)(props)
}

function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    layout: describePanelLayout(400),
    onKey: () => {},
    disabled: false,
    onApp: () => {},
    appBusy: false,
    ...overrides,
  }
}

test('actionErrorKind: 409 E_APP_DRAWER_UNAVAILABLE gets the launcher hint', () => {
  const unavailable = new ActionApiError('E_APP_DRAWER_UNAVAILABLE', 'no launcher', 409)
  assert.equal(isAppDrawerUnavailable(unavailable), true)
  assert.equal(actionErrorKind(unavailable), 'unavailable')
  assert.equal(actionErrorKey(unavailable), 'panel.app.unavailable')
  assert.equal(actionErrorKind(new ActionApiError('E_HTTP', 'boom', 500)), 'error')
  assert.equal(actionErrorKey(new ActionApiError('E_HTTP', 'boom', 500)), 'panel.app.failed')
  assert.equal(actionErrorKind(new Error('network')), 'error')
})

test('createFetchActionApi posts {action} to /dsh-phone/api/action', async () => {
  const original = globalThis.fetch
  const seen: { url: string; init?: RequestInit }[] = []
  try {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await createFetchActionApi().run('app-drawer')
    assert.equal(seen[0]!.url, '/dsh-phone/api/action')
    assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)), { action: 'app-drawer' })
  } finally {
    globalThis.fetch = original
  }
})

test('createFetchActionApi keeps the 409 code for the unavailable hint', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error: { code: 'E_APP_DRAWER_UNAVAILABLE', message: 'missing launcher' } }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    await assert.rejects(
      () => createFetchActionApi().run('app-drawer'),
      (error: unknown) =>
        error instanceof ActionApiError && error.code === 'E_APP_DRAWER_UNAVAILABLE' && error.status === 409,
    )
  } finally {
    globalThis.fetch = original
  }
})

test('footer renders six buttons and the app button calls onApp', () => {
  let appCalls = 0
  const tree = footer(baseProps({ onApp: () => { appCalls += 1 } }))
  const buttons: FakeElement[] = []
  walk(tree, (element) => { if (element.type === 'button') buttons.push(element) })
  assert.equal(buttons.length, 6, '5 device keys + app')
  const appButton = buttons.find((button) => button.props.title === 'panel.keys.app')
  assert.ok(appButton, 'app button exists')
  assert.equal(appButton!.props['aria-label'], 'panel.keys.app')
  assert.equal(appButton!.props.disabled, false)
  ;(appButton!.props.onClick as () => void)()
  assert.equal(appCalls, 1)
})

test('app button has a text label on regular widths and icon-only on compact', () => {
  const regular = footer(baseProps())
  const appRegular: FakeElement[] = []
  walk(regular, (element) => {
    if (element.type === 'button' && element.props.title === 'panel.keys.app') appRegular.push(element)
  })
  const regularLabel = appRegular[0]!.children.find(
    (child) => typeof child === 'object' && child !== null && (child as FakeElement).props?.className === 'dshp-key-label',
  )
  assert.ok(regularLabel, 'label visible on regular layout')

  const compact = footer(baseProps({ layout: describePanelLayout(320) }))
  const appCompact: FakeElement[] = []
  walk(compact, (element) => {
    if (element.type === 'button' && element.props.title === 'panel.keys.app') appCompact.push(element)
  })
  assert.equal(appCompact.length, 1)
  assert.equal(appCompact[0]!.props['aria-label'], 'panel.keys.app', 'aria kept when label hidden')
  const compactLabel = appCompact[0]!.children.find(
    (child) => typeof child === 'object' && child !== null && (child as FakeElement).props?.className === 'dshp-key-label',
  )
  assert.equal(compactLabel, undefined, 'no text label on compact width')
})

test('busy disables the app button and feedback renders with the right tone', () => {
  const busy = footer(baseProps({ appBusy: true }))
  const busyButton: FakeElement[] = []
  walk(busy, (element) => {
    if (element.type === 'button' && element.props.title === 'panel.keys.app') busyButton.push(element)
  })
  assert.equal(busyButton[0]!.props.disabled, true)

  const ok = footer(baseProps({ appFeedback: { kind: 'ok', text: 'ok!' } }))
  const okText: FakeElement[] = []
  walk(ok, (element) => { if (element.type === 'p') okText.push(element) })
  assert.ok(okText.some((element) => String(element.props.className).includes('dshp-message')))
  assert.ok(okText.some((element) => element.children[0] === 'ok!'))

  const unavailable = footer(baseProps({ appFeedback: { kind: 'unavailable', text: 'need launcher' } }))
  const warn: FakeElement[] = []
  walk(unavailable, (element) => {
    if (element.type === 'p' && String(element.props.className).includes('dshp-message--warn')) warn.push(element)
  })
  assert.equal(warn.length, 1)

  const failed = footer(baseProps({ appFeedback: { kind: 'error', text: 'boom' } }))
  const errorClasses: string[] = []
  walk(failed, (element) => {
    if (element.type === 'p') errorClasses.push(String(element.props.className))
  })
  assert.ok(errorClasses.some((className) => className.includes('dshp-message--error')))
})
