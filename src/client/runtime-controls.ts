/**
 * Lifecycle controller for the panel + settings (issue #83).
 *
 * One hook owns the /runtime polling, action dispatch, confirmation and
 * feedback; presentational pieces live in runtime-views.ts. Actions are
 * asynchronous on the Host, so the poller switches to 1s while busy and back to
 * 3s when the view settles; failures keep a readable retry path.
 */
import type * as ReactNamespace from 'react'
import type { Translate } from './i18n.ts'
import type { RuntimeAction, RuntimeApi, RuntimeView } from './runtime-api.ts'
import { isActionAvailable, stopConfirmKey } from './runtime-api.ts'
import { RuntimePoller, describeRuntimeUi, runtimeErrorKey, runtimeStateKey } from './runtime-flow.ts'
import { createRuntimeViews } from './runtime-views.ts'
import type { RuntimeControllerLike } from './runtime-views.ts'

export interface RuntimeControlsDeps {
  React: typeof ReactNamespace
  t: Translate
  api: RuntimeApi
  /** Injectable confirm (tests); defaults to window.confirm. */
  confirm?: (message: string) => boolean
}

export interface RuntimeController extends RuntimeControllerLike {
  stateKey: string
}

/** Build the lifecycle controller + components for the current locale. */
export function createRuntimeControls(deps: RuntimeControlsDeps): {
  useRuntime: () => RuntimeController
  HeaderActions: ReactNamespace.ComponentType<{ runtime: RuntimeController }>
  StoppedOverlay: ReactNamespace.ComponentType<{ runtime: RuntimeController }>
  SettingsSection: ReactNamespace.ComponentType<{ runtime: RuntimeController }>
  MessageBar: ReactNamespace.ComponentType<{ runtime: RuntimeController }>
} {
  const { React, t, api } = deps
  const views = createRuntimeViews({ React, t })
  const h = React.createElement

  function useRuntime(): RuntimeController {
    const [view, setView] = React.useState<RuntimeView>()
    const [failure, setFailure] = React.useState<unknown>()
    const [action, setAction] = React.useState<RuntimeAction>()
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState<string>()
    const [message, setMessage] = React.useState<string>()
    const pollerRef = React.useRef<RuntimePoller | null>(null)
    const lastActionRef = React.useRef<RuntimeAction | undefined>(undefined)

    React.useEffect(() => {
      const poller = new RuntimePoller({
        api,
        onView: (next) => {
          setView(next)
          setFailure(undefined)
          const finished = lastActionRef.current
          if (finished !== undefined && !next.busy) {
            lastActionRef.current = undefined
            setBusy(false)
            setAction(finished)
            setMessage(t('runtime.done.' + finished))
            poller.setFast(false)
          }
        },
        onFailure: (pollError) => setFailure(pollError),
      })
      pollerRef.current = poller
      poller.start()
      return () => {
        poller.dispose()
        pollerRef.current = null
      }
    }, [])

    const onAction = (next: RuntimeAction): void => {
      if (view === undefined || !isActionAvailable(view, next)) return
      if (next === 'stop') {
        const confirm = deps.confirm ?? ((text: string) => typeof window !== 'undefined' && window.confirm(text))
        if (!confirm(t(stopConfirmKey(view)))) return
      }
      lastActionRef.current = next
      setBusy(true)
      setAction(next)
      setError(undefined)
      setMessage(undefined)
      pollerRef.current?.setFast(true)
      void api.act(next).catch((failureAction) => {
        lastActionRef.current = undefined
        pollerRef.current?.setFast(false)
        setBusy(false)
        setError(t(runtimeErrorKey(failureAction)))
      })
    }

    const onRecheck = (): void => {
      setError(undefined)
      setFailure(undefined)
      void pollerRef.current?.refresh()
    }

    const ui = describeRuntimeUi(view, failure)
    const failureCopy =
      failure !== undefined && !ui.available ? t(runtimeErrorKey(failure)) : undefined
    return {
      ...ui,
      stateKey: runtimeStateKey(view),
      busy: busy || ui.view?.busy === true,
      action,
      error: error ?? failureCopy,
      message,
      onAction,
      onRecheck,
    }
  }

  function HeaderActions(props: { runtime: RuntimeController }): ReactNamespace.ReactElement {
    return views.header(props.runtime)
  }
  function StoppedOverlay(props: { runtime: RuntimeController }): ReactNamespace.ReactElement {
    return views.stoppedOverlay(props.runtime)
  }
  function SettingsSection(props: { runtime: RuntimeController }): ReactNamespace.ReactElement {
    return views.settings(props.runtime)
  }
  function MessageBar(props: { runtime: RuntimeController }): ReactNamespace.ReactElement | null {
    return views.messageBar(props.runtime)
  }

  HeaderActions.displayName = 'DshPhoneRuntimeHeaderActions'
  StoppedOverlay.displayName = 'DshPhoneRuntimeStoppedOverlay'
  SettingsSection.displayName = 'DshPhoneRuntimeSettingsSection'
  MessageBar.displayName = 'DshPhoneRuntimeMessageBar'
  void h
  return { useRuntime, HeaderActions, StoppedOverlay, SettingsSection, MessageBar }
}
