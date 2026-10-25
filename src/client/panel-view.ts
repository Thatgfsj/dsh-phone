/**
 * Streaming body of the phone panel (issue #62 layout).
 *
 * Mounted only when the configuration gate is ready (panel.ts). Composition:
 *   header  (chrome + boot progress)   panel-header.ts
 *   stage   (canvas + centered states) panel-stage.ts
 *   footer  (device keys + hint)       panel-footer.ts
 *
 * Layout width is measured on the root with a ResizeObserver and turned into a
 * pure `PanelLayout` (layout.ts), so the 320–600px dock widths get deliberate
 * narrow layouts instead of squeezed flex rows.
 */
import type * as ReactNamespace from 'react'
import type { DecoderKind } from './decoder.ts'
import { StreamDecoder } from './decoder.ts'
import type { ParsedVideoFrame, ServerMessage, VisibilitySources } from './connection.ts'
import type { Translate } from './i18n.ts'
import { VisibilityGate } from './connection.ts'
import { BootStatusPoller, describeBootProgress } from './boot.ts'
import type { BootProgress } from './boot.ts'
import { describePanelLayout, PANEL_DEFAULT_WIDTH } from './layout.ts'
import type { PanelLayout } from './layout.ts'
import { createPanelFooter } from './panel-footer.ts'
import { createPanelHeader } from './panel-header.ts'
import { createPanelStage } from './panel-stage.ts'
import { CLIENT_CSS } from './styles.ts'
import { StreamClient } from './stream.ts'
import type { StreamState } from './stream.ts'
import { mapKeyboardKey, mapPointerToDevice } from './input.ts'
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
  const PanelHeader = createPanelHeader({ React, t })
  const PanelStage = createPanelStage({ React, t })
  const PanelFooter = createPanelFooter({ React, t })

  function PhonePanel(): ReactNamespace.ReactElement {
    const rootRef = React.useRef<HTMLDivElement | null>(null)
    const stageRef = React.useRef<HTMLDivElement | null>(null)
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
    const clientRef = React.useRef<StreamClient | null>(null)
    const draggingRef = React.useRef(false)
    const deviceRef = React.useRef({ width: 0, height: 0 })
    const [layout, setLayout] = React.useState<PanelLayout>(describePanelLayout(PANEL_DEFAULT_WIDTH))
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
        const root = rootRef.current
        if (root !== null) setLayout(describePanelLayout(root.clientWidth))
        const rect = stage.getBoundingClientRect()
        decoder.renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1)
      }
      applySize()

      const client = new StreamClient({
        viewport: () => ({
          w: deviceRef.current.width || 720,
          h: deviceRef.current.height || 1280,
        }),
        onFrame: (frame: ParsedVideoFrame) => decoder.push(frame),
        onMessage: (message: ServerMessage) => {
          if (message.type === 'ready') {
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
        typeof ResizeObserver === 'undefined'
          ? undefined
          : new ResizeObserver(() => {
              applySize()
            })
      resizeObserver?.observe(stage)
      if (rootRef.current !== null) resizeObserver?.observe(rootRef.current)

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
      return mapPointerToDevice(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { width: rect.width, height: rect.height },
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

    const reconnect = (): void => clientRef.current?.reconnect()
    const sendKey = (name: 'HOME' | 'BACK' | 'RECENTS' | 'ENTER' | 'DEL'): void => clientRef.current?.sendKey(name)

    return h(
      'div',
      { className: 'dshp-root', ref: rootRef },
      h('style', { key: 'dshp-style' }, CLIENT_CSS),
      h(PanelHeader, {
        layout,
        status,
        kind,
        boot,
        meta,
        onReconnect: reconnect,
        reconnectDisabled: status === 'hidden',
      }),
      h(PanelStage, {
        status,
        boot,
        error,
        onRetry: reconnect,
        stageRef,
        canvasRef,
        onPointerDown,
        onPointerMove,
        onPointerUp: endPointer,
        onPointerCancel: endPointer,
        onKeyDown,
      }),
      h(PanelFooter, { layout, onKey: sendKey, disabled: false }),
    )
  }

  PhonePanel.displayName = 'DshPhonePanel'
  return PhonePanel
}
