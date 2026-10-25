/**
 * Presentational pieces of the provisioning UI (progress + collapsible manual
 * commands). Split from provision-card.ts so both files stay within the
 * 300-line target; they receive a plain state object and return elements.
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'
import { INSTALL_COMMANDS } from './onboarding-flow.ts'
import type { ProvisionView } from './provision-flow.ts'

export interface ProvisionViewState {
  view: ProvisionView
  logs: string[]
  stepText: string
  percent: number
  manualOpen: boolean
  onStart: () => void
  onStop: () => void
  onManual: () => void
  onAccept: (choice: 'emulator' | 'redroid' | 'attach') => void
}

export interface ProvisionViewsDeps {
  React: typeof ReactNamespace
  t: Translate
}
export function createProvisionViews(deps: ProvisionViewsDeps): {
  renderProgress: (state: ProvisionViewState) => ReactNamespace.ReactElement
  renderManual: (state: ProvisionViewState, includeChoices: boolean) => ReactNamespace.ReactElement
} {
  const { React, t } = deps
  const h = React.createElement

  function renderProgress(flow: ProvisionViewState): ReactNamespace.ReactElement {
    const { view, logs, stepText, percent } = flow
    return h(
      'div',
      { className: 'dshp-provision' },
      h('p', { className: 'dshp-text dshp-text--left' }, stepText + ' · ' + percent + '%'),
      h(
        'div',
        { className: 'dshp-progress', role: 'progressbar', 'aria-valuenow': percent },
        h('div', { className: 'dshp-progress-bar', style: { width: percent + '%' } }),
      ),
      logs.length === 0
        ? null
        : h(
            'div',
            { className: 'dshp-logs' },
            ...logs.map((line, index) =>
              h('div', { className: 'dshp-log-line', key: String(index) }, line),
            ),
          ),
      view.status?.error !== undefined
        ? h('p', { className: 'dshp-text dshp-error' }, view.status.error)
        : null,
      h(
        'div',
        { className: 'dshp-actions' },
        view.active
          ? h('button', { type: 'button', className: 'dshp-button', onClick: flow.onStop }, t('provision.stop'))
          : null,
        view.failed
          ? h('button', { type: 'button', className: 'dshp-button', onClick: flow.onStart }, t('provision.retry'))
          : null,
        h('button', { type: 'button', className: 'dshp-button', onClick: flow.onManual }, t('onboarding.manual')),
      ),
    )
  }

  function renderManual(flow: ProvisionViewState, includeChoices: boolean): ReactNamespace.ReactElement {
    return h(
      'div',
      { className: 'dshp-manual' },
      h(
        'details',
        { className: 'dshp-details', open: flow.manualOpen },
        h('summary', { className: 'dshp-text dshp-text--left' }, t('onboarding.manual')),
        h('p', { className: 'dshp-text dshp-text--left dshp-text--secondary' }, t('onboarding.choice.emulatorNote')),
        h('code', { className: 'dshp-command' }, INSTALL_COMMANDS.emulator),
        h('p', { className: 'dshp-text dshp-text--left dshp-text--secondary' }, t('onboarding.choice.redroidNote')),
        h('code', { className: 'dshp-command' }, INSTALL_COMMANDS.redroid),
        h('p', { className: 'dshp-text dshp-text--left dshp-text--secondary' }, t('onboarding.choice.attachNote')),
        includeChoices
          ? h(
              'div',
              { className: 'dshp-actions' },
              h(
                'button',
                { type: 'button', className: 'dshp-button', onClick: () => flow.onAccept('emulator') },
                t('onboarding.choice.emulator'),
              ),
              h(
                'button',
                { type: 'button', className: 'dshp-button', onClick: () => flow.onAccept('redroid') },
                t('onboarding.choice.redroid'),
              ),
              h(
                'button',
                { type: 'button', className: 'dshp-button', onClick: () => flow.onAccept('attach') },
                t('onboarding.choice.attach'),
              ),
            )
          : null,
      ),
    )
  }


  return { renderProgress, renderManual }
}
