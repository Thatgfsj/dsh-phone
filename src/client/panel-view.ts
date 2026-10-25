/**
 * Streaming body of the phone panel (canvas, connection chrome, reconnect and
 * input forwarding). Mounted only when the panel gate is `ready` (see panel.ts).
 *
 * It streams only while the tab body is visible: an IntersectionObserver plus
 * `visibilitychange` feed a {@link VisibilityGate}, and hiding closes the socket
 * with code 1000 so the Host can stop encoding (docs/protocol.md §2.4).
 */
import type * as ReactNamespace from 'react'
import type { DecoderKind } from './decoder.ts'
import { StreamDecoder } from './decoder.ts'
import type { ParsedVideoFrame, ServerMessage, VisibilitySources } from './connection.ts'
import type { Translate } from './i18n.ts'
import { VisibilityGate } from './connection.ts'
import { BootStatusPoller, createBootIndicator, describeBootProgress } from './boot.ts'
import type { BootProgress } from './boot.ts'
import { statusLabel, statusTone } from './panel-status.ts'
import { CLIENT_CSS } from './styles.ts'
import { StreamClient } from './stream.ts'
import type { StreamState } from './stream.ts'
import { KEY_BUTTONS, mapKeyboardKey, mapPointerToDevice } from './input.ts'
import type { ConfigApi } from './settings-api.ts'

export interface PanelViewDeps {
  React: typeof ReactNamespace
  t: Translate
  api: ConfigApi
}

/** Build the panel body component for the current locale. */
export function createPhonePanelView(deps: PanelViewDeps): ReactNamespace.ComponentType {
  const { React, t, api } = deps
  const h = React.createElement
  const BootIndicator = createBootIndicator({ React, t })
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
    const [boot, setBoot] = React.useState<BootProgress>()
    const bootPollerRef = React.useRef<BootStatusPoller | null>(null)

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
        // The first hello may precede `ready`; fall back to the default 720p
        // portrait so the Host never receives a zero viewport.
        viewport: () => ({
          w: deviceRef.current.width || 720,
          h: deviceRef.current.height || 1280,
        }),
        onFrame: (frame: ParsedVideoFrame) => decoder.push(frame),
        onMessage: (message: ServerMessage) => {
          if (message.type === 'ready') {
            // The Host may report the real framebuffer; fall back to the video size.
            deviceRef.current = {
              width: message.deviceWidth ?? message.width,
              height: message.deviceHeight ?? message.height,
            }
            decoder.renderer.setDeviceSize(message.width, message.height)
            setMeta({ width: message.width, height: message.height, codec: message.codec, maxFps: message.maxFps })
            setError(undefined)
          } else if (message.type === 'error') {
            setError(t('panel.error.stream', { message: message.message }))
          } else if (message.type === 'state') {
            if (message.state === 'booting') {
              if (message.bootMs !== undefined) setBoot(describeBootProgress(message.bootMs))
              if (bootPollerRef.current === null) {
                bootPollerRef.current = new BootStatusPoller({
                  getStatus: () => api.getStatus(),
                  onProgress: (progress) => setBoot(progress),
                })
              }
              bootPollerRef.current.start()
            } else {
              bootPollerRef.current?.stop()
              bootPollerRef.current = null
              setBoot(undefined)
            }
          }
        },
        onState: (state) => {
          setStatus(state)
          if (state === 'hidden' || state === 'closed') {
            bootPollerRef.current?.stop()
            bootPollerRef.current = null
            setBoot(undefined)
          }
        },
        onError: (failure) =>
          setError(
            failure.code === 'E_AUTH' ? t('panel.error.auth') : t('panel.error.stream', { message: failure.message }),
          ),
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
        bootPollerRef.current?.stop()
        bootPollerRef.current = null
      }
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
      if (boot !== undefined) return undefined
      if (status === 'ready') return undefined
      if (status === 'hidden') return t('panel.status.hidden')
      return statusLabel(t, status)
    })()

    return h(
      'div',
      { className: 'dshp-root' },
      h('style', { key: 'dshp-style' }, CLIENT_CSS),
      h(
        'div',
        { className: 'dshp-row' },
        h('span', { className: 'dshp-badge', 'data-tone': statusTone(status) }, statusLabel(t, status)),
        boot === undefined ? null : h(BootIndicator.badge, { progress: boot }),
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
        boot === undefined ? null : h(BootIndicator.overlay, { progress: boot }),
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
export function createPhonePanelTitle(deps: PanelViewDeps): ReactNamespace.ComponentType {
  const { React, t } = deps
  function PhonePanelTitle(): ReactNamespace.ReactElement {
    return React.createElement('span', null, t('panel.title'))
  }
  PhonePanelTitle.displayName = 'DshPhonePanelTitle'
  return PhonePanelTitle
}
