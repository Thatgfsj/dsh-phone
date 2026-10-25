/**
 * Panel footer (issue #62): compact icon buttons for the device keys plus the
 * settings hint. Buttons wrap as a group and keep their labels via `title`/
 * `aria-label`; the narrow dock hides the text label (container query) instead of
 * squeezing it into a vertical column.
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'
import { KEY_BUTTONS } from './input.ts'
import type { PanelLayout } from './layout.ts'

export interface PanelFooterProps {
  layout: PanelLayout
  /** Forward one device key (HOME/BACK/RECENTS/ENTER/DEL). */
  onKey: (name: 'HOME' | 'BACK' | 'RECENTS' | 'ENTER' | 'DEL') => void
  disabled: boolean
}

export interface PanelFooterDeps {
  React: typeof ReactNamespace
  t: Translate
}

/** One glyph per device key, drawn with the current theme colour. */
const KEY_PATHS: Readonly<Record<'HOME' | 'BACK' | 'RECENTS' | 'ENTER' | 'DEL', string>> = {
  HOME: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z',
  BACK: 'M15 5 8 12l7 7',
  RECENTS: 'M5 7h14M5 12h14M5 17h9',
  ENTER: 'M9 5v6h9M14 8l4 3-4 3',
  DEL: 'M8 6h11v12H8l-4-6z',
}

function keyIcon(h: typeof ReactNamespace.createElement, name: keyof typeof KEY_PATHS): ReactNamespace.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' },
    h('path', {
      d: KEY_PATHS[name],
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/** Build the panel footer component for the current locale. */
export function createPanelFooter(deps: PanelFooterDeps): ReactNamespace.ComponentType<PanelFooterProps> {
  const { React, t } = deps
  const h = React.createElement

  function PanelFooter(props: PanelFooterProps): ReactNamespace.ReactElement {
    const { layout, onKey, disabled } = props
    return h(
      'footer',
      { className: 'dshp-footer' },
      h(
        'div',
        { className: 'dshp-keyrow' },
        ...KEY_BUTTONS.map((button) =>
          h(
            'button',
            {
              type: 'button',
              key: button.name,
              className: 'dshp-key-btn',
              title: t(button.label),
              'aria-label': t(button.label),
              onClick: () => onKey(button.name as 'HOME' | 'BACK' | 'RECENTS' | 'ENTER' | 'DEL'),
              disabled,
            },
            keyIcon(h, button.name as keyof typeof KEY_PATHS),
            layout.showKeyLabels ? h('span', { className: 'dshp-key-label' }, t(button.label)) : null,
          ),
        ),
      ),
      h('p', { className: 'dshp-text dshp-text--secondary dshp-footer-hint' }, t('panel.settingsHint')),
    )
  }

  PanelFooter.displayName = 'DshPhonePanelFooter'
  return PanelFooter
}
