/**
 * Small copies/tone helpers shared by the panel body (kept out of panel-view.ts
 * so that file stays within the 300-line target after the boot-progress work).
 */
import type { Translate } from './i18n.ts'
import type { StreamState } from './stream.ts'

/** Short status badge copy per stream state. */
export function statusLabel(t: Translate, state: StreamState): string {
  switch (state) {
    case 'idle':
      return t('panel.status.idle')
    case 'connecting':
      return t('panel.status.connecting')
    case 'open':
      return t('panel.status.open')
    case 'ready':
      return t('panel.status.ready')
    case 'reconnecting':
      return t('panel.status.reconnecting')
    case 'closed':
      return t('panel.status.closed')
    case 'hidden':
      return t('panel.status.hidden')
  }
}

/** Badge tone for a stream state (`neutral` | `warn` | `ok`). */
export function statusTone(state: StreamState): string {
  if (state === 'ready') return 'ok'
  if (state === 'connecting' || state === 'open' || state === 'reconnecting') return 'warn'
  return 'neutral'
}
