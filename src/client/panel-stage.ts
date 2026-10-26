/**
 * Panel stage (issue #62): the video canvas plus the centered overlays.
 *
 * Root-cause fix: overlays are `flex-direction: column` and every text child is
 * a `.dshp-text` block (width 100%, wrapped) — never a raw string child of a row
 * — so CJK copy wraps instead of collapsing into a vertical one-character line.
 */
import type * as ReactNamespace from 'react'
import type { BootProgress } from './boot.ts'
import type { Translate } from './i18n.ts'
import type { StageView } from './layout.ts'
import { describeStageView, summarizeBoot } from './layout.ts'
import { statusLabel } from './panel-status.ts'
import type { StreamState } from './stream.ts'

export interface PanelStageProps {
  status: StreamState
  boot?: BootProgress
  error?: string
  /** Host runtime is stopped: show the stopped/start overlay. */
  runtimeStopped?: boolean
  /** Optional custom stopped overlay (runtime controller); falls back to text. */
  stoppedOverlay?: ReactNamespace.ReactElement | null
  onRetry: () => void
  stageRef: ReactNamespace.RefObject<HTMLDivElement | null>
  canvasRef: ReactNamespace.RefObject<HTMLCanvasElement | null>
  onPointerDown: (event: ReactNamespace.PointerEvent<HTMLCanvasElement>) => void
  onPointerMove: (event: ReactNamespace.PointerEvent<HTMLCanvasElement>) => void
  onPointerUp: (event: ReactNamespace.PointerEvent<HTMLCanvasElement>) => void
  onPointerCancel: (event: ReactNamespace.PointerEvent<HTMLCanvasElement>) => void
  onKeyDown: (event: ReactNamespace.KeyboardEvent<HTMLCanvasElement>) => void
}

export interface PanelStageDeps {
  React: typeof ReactNamespace
  t: Translate
}

function spinner(h: typeof ReactNamespace.createElement): ReactNamespace.ReactElement {
  return h('div', { className: 'dshp-spinner', 'aria-hidden': 'true' })
}

/** Build the stage component for the current locale. */
export function createPanelStage(deps: PanelStageDeps): ReactNamespace.ComponentType<PanelStageProps> {
  const { React, t } = deps
  const h = React.createElement

  function PanelStage(props: PanelStageProps): ReactNamespace.ReactElement {
    const { status, boot, error, runtimeStopped, stoppedOverlay, onRetry } = props
    const view: StageView = describeStageView({ status, booting: boot !== undefined, error, runtimeStopped })
    const summary = boot === undefined ? undefined : summarizeBoot(boot)

    return h(
      'div',
      { className: 'dshp-stage', ref: props.stageRef },
      h('canvas', {
        ref: props.canvasRef,
        className: 'dshp-canvas',
        tabIndex: 0,
        'aria-label': t('panel.title'),
        onPointerDown: props.onPointerDown,
        onPointerMove: props.onPointerMove,
        onPointerUp: props.onPointerUp,
        onPointerCancel: props.onPointerCancel,
        onKeyDown: props.onKeyDown,
      }),
      view === 'canvas'
        ? null
        : h(
            'div',
            { className: 'dshp-overlay', 'data-view': view },
            view === 'stopped'
              ? stoppedOverlay ?? h('div', { className: 'dshp-text' }, t('runtime.stopped.title'))
              : view === 'error'
                ? h('div', { className: 'dshp-text dshp-error' }, error ?? t('panel.error.fatal'))
                : spinner(h),
            view === 'booting'
              ? h(
                  'div',
                  { className: 'dshp-text' },
                  summary === undefined ? t('panel.stage.waiting') : t(summary.phaseKey),
                )
              : null,
            view === 'booting'
              ? h(
                  'div',
                  { className: 'dshp-progress dshp-overlay-progress', role: 'progressbar', 'aria-valuenow': summary?.percent ?? 0 },
                  h('div', { className: 'dshp-progress-bar', style: { width: (summary?.percent ?? 0) + '%' } }),
                )
              : null,
            view === 'booting' && summary !== undefined
              ? h(
                  'div',
                  { className: 'dshp-text dshp-text--secondary' },
                  t('panel.boot.progress', { seconds: summary.seconds }) + ' · ' + t('panel.boot.estimate', { seconds: summary.estimateSeconds }),
                )
              : null,
            view === 'booting' && summary?.timedOut === true
              ? h('div', { className: 'dshp-text dshp-text--secondary' }, t('panel.boot.phase.slow'))
              : null,
            view === 'connecting'
              ? h(
                  'div',
                  { className: 'dshp-text' },
                  status === 'hidden' ? statusLabel(t, status) : t('panel.stage.connecting'),
                )
              : null,
            view === 'connecting'
              ? h('div', { className: 'dshp-text dshp-text--secondary' }, statusLabel(t, status))
              : null,
            view === 'error'
              ? h(
                  'div',
                  { className: 'dshp-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'dshp-button', onClick: onRetry },
                    t('panel.empty.retry'),
                  ),
                )
              : null,
          ),
    )
  }

  PanelStage.displayName = 'DshPhonePanelStage'
  return PanelStage
}
