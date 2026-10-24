/**
 * Right-Sidebar phone panel: canvas, connection chrome, reconnect and input
 * forwarding.
 *
 * The tab body is registered into `sidebar.right.pane.tab` under the tab
 * definition's id (docs/architecture.md §2.4); this component is only the body,
 * the seat/title lives in index.ts. It streams only while the tab body is
 * actually visible: an IntersectionObserver plus `visibilitychange` feed a
 * {@link VisibilityGate}, and hiding closes the socket with code 1000 so the
 * Host can stop encoding (docs/protocol.md §2.4).
 */
import type * as ReactNamespace from 'react'
import type { DecoderKind } from './decoder.ts'
import { StreamDecoder } from './decoder.ts'
import type { ParsedVideoFrame, ServerMessage, VisibilitySources } from './connection.ts'
import { VisibilityGate } from './connection.ts'
import { CLIENT_CSS } from './styles.ts'
import { StreamClient } from './stream.ts'
import type { StreamState } from './stream.ts'
import { mapKeyboardKey, mapPointerToDevice } from './input.ts'

export type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string

export interface PanelDeps {
  React: typeof ReactNamespace
  t: Translate
}

const KEY_BUTTONS: readonly { name: 'HOME' | 'BACK' | 'RECENTS' | 'ENTER' | 'DEL'; label: string }[] = [
  { name: 'HOME', label: 'panel.keys.home' },
  { name: 'BACK', label: 'panel.keys.back' },
  { name: 'RECENTS', label: 'panel.keys.recents' },
  { name: 'ENTER', label: 'panel.keys.enter' },
  { name: 'DEL', label: 'panel.keys.del' },
]

/** Build the panel body component for the current locale. */
export function createPhonePanel(deps: PanelDeps): ReactNamespace.ComponentType {
  const { React, t } = deps
  const h = React.createElement

  /** Short status badge copy per state. */
  function statusLabel(state: StreamState): string {
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

  function statusTone(state: StreamState): string {
    if (state === 'ready') return 'ok'
    if (state === 'connecting' || state === 'open' || state === 'reconnecting') return 'warn'
    return 'neutral'
  }

  function PhonePanel(): ReactNamespace.ReactElement {
    const stageRef = React.useRef<HTMLDivElement | null>(null)
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
    const clientRef = React.useRef<StreamClient | null>(null)
    const draggingRef = React.useRef(false)
    const deviceRef = React.useRef({ width: 0, height: 0 })
    const [status, setStatus] = React.useState<StreamState>('idle')
    const [kind, setKind] = React.useState<DecoderKind | 'pending'>('pending')
    const [meta, setMeta] = React.useState<{ width: number; height: number; codec: string; maxFps: number }>()
    const [error, setError] = React.useState<string>()

    React.useEffect(() => {
      const stage = stageRef.current
      const canvas = canvasRef.current
      if (stage === null || canvas === null) return

      const decoder = StreamDecoder.create({
        canvas,
        onKindChange: (next) => setKind(next),
        onError: (message) => setError(t('panel.error.decoder', { message })),
      })

      const applySize = (): void => {
        const rect = stage.getBoundingClientRect()
        decoder.renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1)
      }
      applySize()

      const client = new StreamClient({
        viewport: () => ({ w: deviceRef.current.width, h: deviceRef.current.height }),
        onFrame: (frame: ParsedVideoFrame) => decoder.push(frame),
        onMessage: (message: ServerMessage) => {
          if (message.type === 'ready') {
            deviceRef.current = { width: message.width, height: message.height }
            decoder.renderer.setDeviceSize(message.width, message.height)
            setMeta({ width: message.width, height: message.height, codec: message.codec, maxFps: message.maxFps })
            setError(undefined)
          } else if (message.type === 'error') {
            setError(t('panel.error.stream', { message: message.message }))
          }
        },
        onState: (state) => setStatus(state),
      })
      clientRef.current = client

      const sources: VisibilitySources = {
        documentVisible: document.visibilityState === 'visible',
        watchDocument: (listener) => {
          const handler = (): void => listener(document.visibilityState === 'visible')
          document.addEventListener('visibilitychange', handler)
          return () => document.removeEventListener('visibilitychange', handler)
        },
        watchIntersection: (listener) => {
          if (typeof IntersectionObserver === 'undefined') {
            listener(true)
            return () => {}
          }
          const observer = new IntersectionObserver(
            (entries) => {
              const entry = entries[entries.length - 1]
              if (entry !== undefined) listener(entry.isIntersecting)
            },
            { threshold: 0.01 },
          )
          observer.observe(stage)
          return () => observer.disconnect()
        },
      }
      const gate = new VisibilityGate(sources, (visible) => client.setVisible(visible))
      gate.start()
      client.start(gate.visible)

      const resizeObserver =
        typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => applySize())
      resizeObserver?.observe(stage)

      return () => {
        resizeObserver?.disconnect()
        gate.stop()
        client.dispose()
        decoder.dispose()
        clientRef.current = null
      }
      // Mount once: the client/decoder own their own reconnect lifecycle.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const pointFromEvent = (event: ReactNamespace.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const rect = event.currentTarget.getBoundingClientRect()
      const box = { width: rect.width, height: rect.height }
      return mapPointerToDevice(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        box,
        deviceRef.current,
      )
    }

    const onPointerDown = (event: ReactNamespace.PointerEvent<HTMLCanvasElement>): void => {
      event.preventDefault()
      draggingRef.current = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const point = pointFromEvent(event)
      clientRef.current?.sendTouch('down', point.x, point.y)
    }

    const onPointerMove = (event: ReactNamespace.PointerEvent<HTMLCanvasElement>): void => {
      if (!draggingRef.current) return
      const point = pointFromEvent(event)
      clientRef.current?.sendTouch('move', point.x, point.y)
    }

    const endPointer = (event: ReactNamespace.PointerEvent<HTMLCanvasElement>): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      const point = pointFromEvent(event)
      clientRef.current?.sendTouch('up', point.x, point.y)
    }

    const onKeyDown = (event: ReactNamespace.KeyboardEvent<HTMLCanvasElement>): void => {
      const name = mapKeyboardKey(event.key)
      if (name === undefined) return
      event.preventDefault()
      clientRef.current?.sendKey(name as 'BACK' | 'ENTER' | 'DEL' | 'HOME' | 'RECENTS')
    }

    const placeholder = ((): string | undefined => {
      if (error !== undefined) return undefined
      if (status === 'ready') return undefined
      if (status === 'hidden') return t('panel.status.hidden')
      return statusLabel(status)
    })()

    return h(
      'div',
      { className: 'dshp-root' },
      h('style', { key: 'dshp-style' }, CLIENT_CSS),
      h(
        'div',
        { className: 'dshp-row' },
        h('span', { className: 'dshp-badge', 'data-tone': statusTone(status) }, statusLabel(status)),
        meta === undefined
          ? null
          : h(
              'span',
              { className: 'dshp-badge' },
              t('panel.meta', {
                width: meta.width,
                height: meta.height,
                codec: meta.codec,
                fps: meta.maxFps,
              }),
            ),
        h(
          'span',
          { className: 'dshp-badge' },
          kind === 'webcodecs'
            ? t('panel.decoder.webcodecs')
            : kind === 'soft'
              ? t('panel.decoder.tinyh264')
              : t('panel.decoder.pending'),
        ),
        h('span', { className: 'dshp-grow' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dshp-button',
            onClick: () => clientRef.current?.reconnect(),
            disabled: status === 'hidden',
          },
          t('panel.reconnect'),
        ),
      ),
      h(
        'div',
        { className: 'dshp-stage', ref: stageRef },
        h('canvas', {
          ref: canvasRef,
          className: 'dshp-canvas',
          tabIndex: 0,
          onPointerDown,
          onPointerMove,
          onPointerUp: endPointer,
          onPointerCancel: endPointer,
          onKeyDown,
        }),
        error === undefined
          ? null
          : h('div', { className: 'dshp-placeholder' }, h('div', { className: 'dshp-error' }, error)),
        error === undefined && placeholder !== undefined
          ? h('div', { className: 'dshp-placeholder' }, placeholder)
          : null,
      ),
      h(
        'div',
        { className: 'dshp-keys' },
        ...KEY_BUTTONS.map((button) =>
          h(
            'button',
            {
              type: 'button',
              key: button.name,
              className: 'dshp-button',
              onClick: () => clientRef.current?.sendKey(button.name),
            },
            t(button.label),
          ),
        ),
      ),
      h('div', { className: 'dshp-hint' }, t('panel.settingsHint')),
    )
  }

  PhonePanel.displayName = 'DshPhonePanel'
  return PhonePanel
}

/** Build the chip title component (second seat under the same tab id). */
export function createPhonePanelTitle(deps: PanelDeps): ReactNamespace.ComponentType {
  const { React, t } = deps
  function PhonePanelTitle(): ReactNamespace.ReactElement {
    return React.createElement('span', null, t('panel.title'))
  }
  PhonePanelTitle.displayName = 'DshPhonePanelTitle'
  return PhonePanelTitle
}
