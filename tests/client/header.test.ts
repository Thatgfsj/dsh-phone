import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HEADER_ENTRY_ID,
  HEADER_SLOT,
  createPhoneHeaderButton,
  headerRegistrationOptions,
  openPhoneTab,
} from '../../src/client/header.ts'

const t = (key: string): string => key

/** Minimal createElement fake: header button uses no hooks. */
function fakeReact() {
  return {
    createElement(type: unknown, props?: unknown, ...children: unknown[]) {
      return { type, props: (props ?? {}) as Record<string, unknown>, children }
    },
  }
}

test('openPhoneTab forwards the kind and swallows a missing-session throw', () => {
  const kinds: string[] = []
  assert.equal(openPhoneTab({ openTab: (kind) => kinds.push(kind) }, 'dshPhone'), true)
  assert.deepEqual(kinds, ['dshPhone'])
  assert.equal(
    openPhoneTab({
      openTab: () => {
        throw new Error('no session on screen')
      },
    }, 'dshPhone'),
    false,
  )
})

test('headerRegistrationOptions uses the additive utilities seat', () => {
  const options = headerRegistrationOptions(t, 'dsh-phone')
  assert.equal(HEADER_SLOT, 'conversation.session.header.utilities')
  assert.equal(options.name, HEADER_SLOT)
  assert.equal(options.id, HEADER_ENTRY_ID)
  assert.equal(options.order, 50)
  assert.equal(options.locale, 'dsh-phone')
  assert.equal((options.label as () => string)(), 'header.open')
})

test('header button renders the phone icon with i18n title/aria and calls openTab', () => {
  let opened = 0
  const Button = createPhoneHeaderButton({
    React: fakeReact() as never,
    t,
    openTab: () => {
      opened += 1
    },
  })
  const element = (Button as unknown as (props: Record<string, never>) => unknown)({}) as {
    type: string
    props: Record<string, unknown>
    children: { type: string; props: Record<string, unknown> }[]
  }
  assert.equal(element.type, 'button')
  assert.equal(element.props.className, 'dshp-header-button')
  assert.equal(element.props.title, 'header.open')
  assert.equal(element.props['aria-label'], 'header.open')
  assert.equal(element.children.length, 1)
  const icon = element.children[0]!
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props['aria-hidden'], 'true')
  assert.equal(icon.props.width, 16)
  assert.equal(opened, 0)
  ;(element.props.onClick as () => void)()
  assert.equal(opened, 1)
})
