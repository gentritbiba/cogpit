import { useLayoutEffect, useRef, useState } from "react"
import type { JsonValue, PluginContext, PluginRequest } from "@cogpit/plugin-contracts"
import { createRuntimeFrame, type RuntimeFrameController } from "./runtimeFrame"

export interface PluginFrameProps {
  payload: ArrayBuffer
  digest: string
  activationKey: string
  context: PluginContext
  execute: (request: PluginRequest, signal: AbortSignal) => Promise<JsonValue>
  active?: boolean
  title?: string
  onReady?: () => void
  onError?: (error: Error) => void
  onDispose?: () => void
}

export function PluginFrame(props: PluginFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const controller = useRef<RuntimeFrameController | null>(null)
  const current = useRef(props)
  const [status, setStatus] = useState<{ key: string; error: string | null; ready: boolean }>({ key: "", error: null, ready: false })
  const projectKey = JSON.stringify(props.context.project)
  const key = `${props.activationKey}:${props.digest}:${projectKey}`
  useLayoutEffect(() => { current.current = props })
  useLayoutEffect(() => {
    if (!frame.current) return
    const options = current.current
    const runtime = createRuntimeFrame({
      frame: frame.current, payload: props.payload, digest: props.digest, context: options.context, active: options.active,
      execute: options.execute,
      onReady: () => { setStatus({ key, error: null, ready: true }); options.onReady?.() },
      onError: (error) => { setStatus({ key, error: error.message, ready: false }); options.onError?.(error) },
      onDispose: options.onDispose,
    })
    controller.current = runtime
    return () => { runtime.dispose(); controller.current = null }
  }, [props.payload, props.digest, key])
  useLayoutEffect(() => { controller.current?.setActive(props.active ?? true); controller.current?.updateContext(props.context) }, [props.active, props.context])
  const state = status.key === key ? status : { error: null, ready: false }
  return (
    <section className="relative h-full min-h-0 w-full" aria-label={props.title ?? "Plugin panel"}>
      {!state.ready && !state.error && <p role="status" className="p-4 text-sm text-muted-foreground">Loading plugin…</p>}
      {state.error && <p role="alert" className="p-4 text-sm text-destructive">{state.error}</p>}
      <iframe ref={frame} title={props.title ?? "Plugin panel"} sandbox="allow-scripts" referrerPolicy="no-referrer"
        className="h-full w-full border-0" hidden={!state.ready || !!state.error || props.active === false} />
    </section>
  )
}
