/**
 * Presentational pieces of the lifecycle controls (issue #83): header action
 * buttons, the stopped/external-kill stage overlay, the settings section and the
 * feedback message bar. All copy goes through explicit `.dshp-text` blocks and
 * only `--dsw-alias-*` tokens are used.
 */
import type * as ReactNamespace from 'react'
import type { RuntimeAction } from './runtime-api.ts'
import { actionProgressKey } from './runtime-api.ts'
import type { Translate } from './i18n.ts'

/** Structural controller shape shared with runtime-controls.ts. */
export interface RuntimeControllerLike {
  available: boolean
  stopped: boolean
  external: boolean
  owned: boolean
  adopted: boolean
  stopKey: string
  canStart: boolean
  canStop: boolean
  canRestart: boolean
  reason?: string
  identity?: string
  busy: boolean
  action?: RuntimeAction
  error?: string
  message?: string
  /** i18n key for the current runtime state. */
  stateKey: string
  onAction: (action: RuntimeAction) => void
  onRecheck: () => void
}

export interface RuntimeViewsDeps {
  React: typeof ReactNamespace
  t: Translate
}

export function createRuntimeViews(deps: RuntimeViewsDeps): {
  header: (runtime: RuntimeControllerLike) => ReactNamespace.ReactElement
  stoppedOverlay: (runtime: RuntimeControllerLike) => ReactNamespace.ReactElement
  settings: (runtime: RuntimeControllerLike) => ReactNamespace.ReactElement
  messageBar: (runtime: RuntimeControllerLike) => ReactNamespace.ReactElement | null
} {
  const { React, t } = deps
  const h = React.createElement

  function busyLabel(runtime: RuntimeControllerLike, action: RuntimeAction, fallback: string): string {
    return runtime.busy && runtime.action === action ? t(actionProgressKey(action)) : fallback
  }

  function button(
    key: string,
    label: string,
    disabled: boolean,
    onClick: () => void,
    tone?: 'primary' | 'danger' | 'large',
  ): ReactNamespace.ReactElement {
    return h(
      'button',
      {
        type: 'button',
        key,
        className: tone === 'large' ? 'dshp-button dshp-button--lg' : 'dshp-button',
        'data-variant': tone === 'primary' ? 'primary' : undefined,
        'data-tone': tone === 'danger' ? 'danger' : undefined,
        disabled,
        onClick,
      },
      label,
    )
  }

  function header(runtime: RuntimeControllerLike): ReactNamespace.ReactElement {
    const busy = runtime.busy
    const disabled = !runtime.available || busy
    return h(
      'div',
      { className: 'dshp-row dshp-runtime-actions' },
      button(
        'restart',
        busyLabel(runtime, 'restart', t('runtime.action.restart')),
        disabled || !runtime.canRestart,
        () => runtime.onAction('restart'),
      ),
      button(
        'stop',
        runtime.stopKey === 'runtime.action.stopOwned'
          ? t('runtime.action.stopOwned')
          : t('runtime.action.disconnect'),
        disabled || !runtime.canStop,
        () => runtime.onAction('stop'),
        'danger',
      ),
    )
  }

  function stoppedOverlay(runtime: RuntimeControllerLike): ReactNamespace.ReactElement {
    const title = !runtime.available
      ? t('runtime.unsupported.title')
      : runtime.external
        ? t('runtime.stopped.externalTitle')
        : t('runtime.stopped.title')
    const reason = !runtime.available ? t('runtime.unsupported.body') : runtime.reason
    return h(
      'div',
      { className: 'dshp-stop' },
      h('div', { className: 'dshp-text dshp-stop-title' }, title),
      reason === undefined ? null : h('p', { className: 'dshp-text dshp-text--secondary' }, reason),
      runtime.identity === undefined
        ? null
        : h('p', { className: 'dshp-text dshp-text--secondary' }, runtime.identity),
      h(
        'div',
        { className: 'dshp-actions dshp-actions--center' },
        button(
          'start',
          busyLabel(runtime, 'start', t('runtime.action.start')),
          !runtime.available || runtime.busy || !runtime.canStart,
          () => runtime.onAction('start'),
          'primary',
        ),
        button(
          'restart',
          busyLabel(runtime, 'restart', t('runtime.action.restart')),
          !runtime.available || runtime.busy || !runtime.canRestart,
          () => runtime.onAction('restart'),
        ),
        button('recheck', t('runtime.action.recheck'), runtime.busy, () => runtime.onRecheck()),
      ),
    )
  }

  function settings(runtime: RuntimeControllerLike): ReactNamespace.ReactElement {
    const ownershipKey = runtime.owned
      ? 'runtime.ownership.owned'
      : runtime.adopted
        ? 'runtime.ownership.adopted'
        : 'runtime.ownership.unknown'
    return h(
      'section',
      { className: 'dshp-card' },
      h('h4', { className: 'dshp-card-title' }, t('runtime.sectionTitle')),
      h(
        'p',
        { className: 'dshp-text dshp-text--left dshp-hint' },
        t('runtime.stateLabel') + ': ' + (runtime.available ? t(runtime.stateKey) : t('runtime.state.unknown')),
      ),
      h('p', { className: 'dshp-text dshp-text--left dshp-note' }, t(ownershipKey)),
      runtime.identity === undefined
        ? null
        : h('p', { className: 'dshp-text dshp-text--left dshp-hint' }, runtime.identity),
      runtime.reason === undefined
        ? null
        : h('p', { className: 'dshp-text dshp-text--left dshp-error' }, runtime.reason),
      h(
        'div',
        { className: 'dshp-actions' },
        button(
          'start',
          busyLabel(runtime, 'start', t('runtime.action.start')),
          !runtime.available || runtime.busy || !runtime.canStart,
          () => runtime.onAction('start'),
          'primary',
        ),
        button(
          'restart',
          busyLabel(runtime, 'restart', t('runtime.action.restart')),
          !runtime.available || runtime.busy || !runtime.canRestart,
          () => runtime.onAction('restart'),
        ),
        button(
          'stop',
          busyLabel(runtime, 'stop', t(runtime.stopKey === 'runtime.action.stopOwned' ? 'runtime.action.stopOwned' : 'runtime.action.disconnect')),
          !runtime.available || runtime.busy || !runtime.canStop,
          () => runtime.onAction('stop'),
          'danger',
        ),
        button('recheck', t('runtime.action.recheck'), runtime.busy, () => runtime.onRecheck()),
      ),
      h('p', { className: 'dshp-text dshp-text--left dshp-hint' }, t('runtime.stopNote')),
      messageBar(runtime),
    )
  }

  function messageBar(runtime: RuntimeControllerLike): ReactNamespace.ReactElement | null {
    if (runtime.error !== undefined) {
      return h('p', { className: 'dshp-text dshp-message dshp-message--error' }, runtime.error)
    }
    if (runtime.message !== undefined) {
      return h('p', { className: 'dshp-text dshp-message' }, runtime.message)
    }
    return null
  }

  return { header, stoppedOverlay, settings, messageBar }
}

