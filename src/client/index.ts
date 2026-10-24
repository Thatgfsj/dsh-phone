/**
 * dsh-phone Web client entry.
 *
 * scripts/build.mjs bundles this file as CJS and wraps it in
 * `window.__ModuleLoader__.load({ id:'dsh-phone', factory(require){...} })`, then
 * calls `module.exports.default(require)`. The default export therefore receives
 * the platform `require` (React only) and returns the Cordis plugin object.
 *
 * Registrations (docs/architecture.md §2.4, docs/calibration.md §4.3/§4.4):
 * - `ctx.sidebarRightTabs.register` — a right-Sidebar tab type, NOT the
 *   `rightbar`/`rightbar.session` single slots (which would shadow the shell).
 * - `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title`, keyed by the
 *   definition id — body and chip title seats.
 * - `settings.section` — the phone settings page.
 *
 * The panel is opened only by an explicit user action (`ctx.sidebarRight.openTab`
 * from the settings page); nothing auto-opens on load.
 */
import type * as ReactNamespace from 'react'
import { NS, en, zh } from './i18n.ts'
import { createPhonePanel, createPhonePanelTitle } from './panel.ts'
import { createPhoneSettings } from './settings.ts'

/** Tab definition id; also the key used by both sidebar seats. */
export const TAB_ID = '@local/dsh-phone/tab'
/** Page kind opened through `ctx.sidebarRight.openTab`. */
export const PHONE_KIND = 'dshPhone'
/** Settings section list key. */
export const SETTINGS_ID = 'dsh-phone'

type FactoryRequire = (id: string) => unknown
type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string

interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): void
  locale: {
    register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(ns: string): Translate
  }
  slots: {
    inject(ownerKey: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  sidebarRightTabs: {
    register(definition: {
      id: string
      kind: string
      priority?: 'extension' | 'builtin' | 'fallback'
      title: () => string
    }): () => void
  }
  sidebarRight: { openTab(kind: string): void }
}

/**
 * Client plugin factory.
 * @param require - platform module seed (only React is used).
 * @returns the Cordis plugin object consumed by the DSH client runner.
 */
export default function createDshPhoneClient(require: FactoryRequire) {
  const React = require('react') as typeof ReactNamespace

  return {
    name: 'dsh-phone',
    inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
    apply(ctx: ClientContext): void {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-phone: locale dictionaries')
      const t = ctx.locale.bind(NS)
      const openPanel = (): void => ctx.sidebarRight.openTab(PHONE_KIND)
      const PhonePanel = createPhonePanel({ React, t })
      const PhonePanelTitle = createPhonePanelTitle({ React, t })
      const PhoneSettings = createPhoneSettings({ React, t, openPanel })

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: PHONE_KIND,
            priority: 'extension',
            title: () => t('panel.title'),
          }),
        'dsh-phone: right sidebar tab type',
      )

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, PhonePanel),
      )
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS },
          PhonePanelTitle,
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: SETTINGS_ID, order: 60, label: () => t('settings.section') },
          PhoneSettings,
        ),
      )
    },
  }
}
