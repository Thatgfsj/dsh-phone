/**
 * Session-header entry for the phone panel (issue #45).
 *
 * Slot choice: `conversation.session.header.utilities` is the additive,
 * right-aligned list seat for Session controls (replaceRisk: none). The
 * `conversation.session.header.corner` single slot is already occupied by the
 * shipped right-sidebar ExpandButton and is catalogued as
 * "shadows-shipped-ui", so claiming it would remove the official expand control.
 *
 * The button only asks the right Sidebar to open the phone tab; the panel itself
 * decides whether it can stream (onboarding gate, Host availability).
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'

/** Additive right-aligned header seat. */
export const HEADER_SLOT = 'conversation.session.header.utilities'
/** Stable id inside the header seat. */
export const HEADER_ENTRY_ID = 'dsh-phone'

export interface HeaderDeps {
  React: typeof ReactNamespace
  t: Translate
  /** Opens (or reveals) the phone tab in the right Sidebar. */
  openTab: () => void
}

/** Open the phone tab, swallowing a "no session on screen" failure. */
export function openPhoneTab(sidebarRight: { openTab(kind: string): void }, kind: string): boolean {
  try {
    sidebarRight.openTab(kind)
    return true
  } catch {
    return false
  }
}

/** Registration options for the header seat (pure, unit-tested). */
export function headerRegistrationOptions(t: Translate, locale: string): Record<string, unknown> {
  return {
    name: HEADER_SLOT,
    id: HEADER_ENTRY_ID,
    order: 50,
    label: () => t('header.open'),
    locale,
  }
}

/** Build the phone-icon header button; no hooks, so tests can call it directly. */
export function createPhoneHeaderButton(deps: HeaderDeps): ReactNamespace.ComponentType {
  const { React, t, openTab } = deps
  const h = React.createElement

  function PhoneHeaderButton(): ReactNamespace.ReactElement {
    const label = t('header.open')
    return h(
      'button',
      {
        type: 'button',
        className: 'dshp-header-button',
        title: label,
        'aria-label': label,
        onClick: () => openTab(),
      },
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          x: 6,
          y: 2,
          width: 12,
          height: 20,
          rx: 2,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('line', {
          x1: 10,
          y1: 18.5,
          x2: 14,
          y2: 18.5,
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      ),
    )
  }

  PhoneHeaderButton.displayName = 'DshPhoneHeaderButton'
  return PhoneHeaderButton
}
