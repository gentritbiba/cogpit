import { useLayoutEffect, useRef, useState } from "react"
import type { PluginExecutionResult, PluginContext, PluginRequest } from "@cogpit/plugin-contracts"
import { createRuntimeFrame, type RuntimeFrameController } from "./runtimeFrame"
import { usePaneLifetime } from "@/contexts/DevicePaneContext"

export interface PluginFrameProps {
  payload: ArrayBuffer
  digest: string
  activationKey: string
  context: PluginContext
  execute: (request: PluginRequest, signal: AbortSignal) => Promise<PluginExecutionResult>
  active?: boolean
  /** Current composer token for a frame granted composer drafts. */
  draftsToken?: string | null
  title?: string
  onReady?: () => void
  onError?: (error: Error) => void
  onDispose?: () => void
}

interface KeptFrame {
  key: string
  payload: ArrayBuffer
  runtime: RuntimeFrameController
  release: () => void
}

export function PluginFrame(props: PluginFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const controller = useRef<RuntimeFrameController | null>(null)
  const kept = useRef<KeptFrame | null>(null)
  const lifetime = usePaneLifetime()
  const current = useRef(props)
  const [status, setStatus] = useState<{ key: string; error: string | null; ready: boolean }>({ key: "", error: null, ready: false })
  const projectKey = JSON.stringify(props.context.project)
  const key = `${props.activationKey}:${props.digest}:${projectKey}`
  useLayoutEffect(() => { current.current = props })
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    let entry = kept.current
    if (entry?.key !== key || entry.payload !== props.payload) {
      entry?.release()
      const options = current.current
      const runtime = createRuntimeFrame({
        frame: element, payload: props.payload, digest: props.digest, context: options.context, active: options.active,
        execute: options.execute,
        onReady: () => { setStatus({ key, error: null, ready: true }); options.onReady?.() },
        onError: (error) => { setStatus({ key, error: error.message, ready: false }); options.onError?.(error) },
        onDispose: options.onDispose,
      })
      // A frame kept through a hidden pane still goes when the pane does.
      const forget = lifetime?.onEnd(() => next.release())
      let released = false
      const next: KeptFrame = {
        key, payload: props.payload, runtime,
        release: () => {
          if (released) return
          released = true
          forget?.()
          runtime.dispose()
          if (kept.current === next) kept.current = null
        },
      }
      kept.current = entry = next
    }
    controller.current = entry.runtime
    const mine = entry
    return () => {
      controller.current = null
      // In a machine's pane, a hidden Activity leaves the iframe in the
      // document, running, for when the pane is shown again; only a frame
      // that has left the document once the commit is done goes.
      if (!lifetime || !element.isConnected) return mine.release()
      queueMicrotask(() => { if (!element.isConnected) mine.release() })
    }
  }, [props.payload, props.digest, key, lifetime])
  useLayoutEffect(() => { controller.current?.setActive(props.active ?? true); controller.current?.updateContext(props.context) }, [props.active, props.context])
  const state = status.key === key ? status : { error: null, ready: false }
  useLayoutEffect(() => { if (props.draftsToken && state.ready) controller.current?.notifyDrafts(props.draftsToken) }, [props.draftsToken, state.ready])
  return (
    <section className="relative h-full min-h-0 w-full" aria-label={props.title ?? "Plugin panel"}>
      {!state.ready && !state.error && <p role="status" className="p-4 text-sm text-muted-foreground">Loading plugin…</p>}
      {state.error && <p role="alert" className="p-4 text-sm text-destructive">{state.error}</p>}
      <iframe ref={frame} title={props.title ?? "Plugin panel"} sandbox="allow-scripts" referrerPolicy="no-referrer"
        className="h-full w-full border-0" hidden={!state.ready || !!state.error || props.active === false} />
    </section>
  )
}
