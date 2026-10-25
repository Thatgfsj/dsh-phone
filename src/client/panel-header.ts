/**
 * Panel header (issue #62): phone icon + title + status badge + reconnect, and
 * the booting progress line. All long copy is an explicit `.dshp-text` block so
 * a narrow dock can never squeeze it into a one-character column.
 */
import type * as ReactNamespace from 'react'
import type { BootProgress } from './boot.ts'
import type { DecoderKind } from './decoder.ts'
import type { Translate } from './i18n.ts'
import type { PanelLayout } from './layout.ts'
import { summarizeBoot } from './layout.ts'
import { statusLabel, statusTone } from './panel-status.ts'
import type { StreamState } from './stream.ts'

export interface PanelHeaderProps {
  layout: PanelLayout
  status: StreamState
  kind: DecoderKind | 'pending'
  boot?: BootProgress
  meta?: { width: number; height: number; codec: string; maxFps: number }
  /** Manual reconnect (also used by the error overlay). */
  onReconnect: () => void
  reconnectDisabled: boolean
}

export interface PanelHeaderDeps {
  React: typeof ReactNamespace
  t: Translate
}

/** Inline phone glyph shared with the conversation-header entry. */
function phoneIcon(h: typeof ReactNamespace.createElement): ReactNamespace.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', focusable: 'false' },
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
  )
}

function reconnectIcon(h: typeof ReactNamespace.createElement): ReactNamespace.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
    h('path', {
      d: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/** Build the panel header component for the current locale. */
export function createPanelHeader(deps: PanelHeaderDeps): ReactNamespace.ComponentType<PanelHeaderProps> {
  const { React, t } = deps
  const h = React.createElement

  function PanelHeader(props: PanelHeaderProps): ReactNamespace.ReactElement {
    const { layout, status, kind, boot, meta, onReconnect, reconnectDisabled } = props
    const showLabels = layout.size !== 'compact'
    const summary = boot === undefined ? undefined : summarizeBoot(boot)
    const decoderLabel =
      kind === 'webcodecs'
        ? t('panel.decoder.webcodecs')
        : kind === 'soft'
          ? t('panel.decoder.tinyh264')
          : t('panel.decoder.pending')
    const secondary =
      meta === undefined ? decoderLabel : t('panel.meta', { width: meta.width, height: meta.height, codec: meta.codec, fps: meta.maxFps }) + ' · ' + decoderLabel

    return h(
      'header',
      { className: 'dshp-header' },
      h(
        'div',
        { className: 'dshp-header-main' },
        h('span', { className: 'dshp-header-icon' }, phoneIcon(h)),
        h('span', { className: 'dshp-title' }, t('panel.title')),
        h('span', { className: 'dshp-badge', 'data-tone': statusTone(status) }, statusLabel(t, status)),
        h(
          'div',
          { className: 'dshp-header-actions' },
          h(
            'button',
            {
              type: 'button',
              className: showLabels ? 'dshp-button' : 'dshp-button dshp-icon-button',
              title: t('panel.reconnect'),
              'aria-label': t('panel.reconnect'),
              onClick: onReconnect,
              disabled: reconnectDisabled,
            },
            reconnectIcon(h),
            showLabels ? h('span', null, t('panel.reconnect')) : null,
          ),
        ),
      ),
      layout.showSecondary && secondary !== ''
        ? h('div', { className: 'dshp-text dshp-text--secondary dshp-text--left' }, secondary)
        : null,
      summary === undefined
        ? null
        : h(
            'div',
            { className: 'dshp-bootline' },
            h(
              'div',
              { className: 'dshp-bootline-head' },
              h('span', { className: 'dshp-text dshp-text--left' }, t('panel.boot.progress', { seconds: summary.seconds })),
              h(
                'span',
                { className: 'dshp-text dshp-text--secondary dshp-text--left' },
                t('panel.boot.estimate', { seconds: summary.estimateSeconds }),
              ),
            ),
            h(
              'div',
              { className: 'dshp-progress', role: 'progressbar', 'aria-valuenow': summary.percent },
              h('div', { className: 'dshp-progress-bar', style: { width: summary.percent + '%' } }),
            ),
          ),
    )
  }

  PanelHeader.displayName = 'DshPhonePanelHeader'
  return PanelHeader
}
