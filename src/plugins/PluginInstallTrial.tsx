import { useLayoutEffect, useRef, useState } from "react"
import type { PluginContext } from "@cogpit/plugin-contracts"
import type { PluginInstallPreview } from "../../shared/contracts/plugins"
import { PluginFrame, type PluginFrameProps } from "./PluginFrame"
import type { RuntimePluginClient } from "./runtimeClient"

const trialContext: PluginContext = { project: null, theme: { mode: "light", tokens: {} }, locale: "en", reducedMotion: true, visible: false }
type TrialPhase = "loading" | "trial" | "committing" | "recovering" | "finished" | "canceled"

interface TrialFrame { key: string; client: RuntimePluginClient; props: PluginFrameProps }

function startTrial({ client, preview, activation, key, onFrame, onComplete, onError }: {
  client: RuntimePluginClient; preview: PluginInstallPreview; activation: string; key: string;
  onFrame: (frame: TrialFrame | null) => void; onComplete: () => void; onError: (error: Error) => void
}): () => void {
  const abort = new AbortController()
  let phase: TrialPhase = "loading"
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline = 0
  const expired = () => new Error("The installation check expired. Review the package again to retry.")
  function fail(error: Error): void {
    if (phase === "canceled" || phase === "finished") return
    phase = "canceled"
    clearTimeout(timer)
    abort.abort()
    onFrame(null)
    onError(error)
  }
  function finish(): void {
    if (phase === "canceled" || phase === "finished") return
    phase = "finished"
    clearTimeout(timer)
    onComplete()
  }
  async function recover(error: Error): Promise<void> {
    if (phase !== "committing") return
    phase = "recovering"
    clearTimeout(timer)
    try {
      const outcome = await client.transactionOutcome(preview)
      if (phase !== "recovering") return
      if (outcome.status === "committed") {
        await client.refresh()
        if (phase === "recovering") finish()
      } else fail(error)
    } catch {
      if (phase === "recovering") fail(new Error("The host did not confirm the installation result. Check Installed after reconnecting before trying again."))
    }
  }
  async function ready(): Promise<void> {
    if (phase !== "trial") return
    if (Date.now() > deadline) { fail(expired()); return }
    phase = "committing"
    try {
      await client.commit(preview, abort.signal)
      if (phase === "committing") finish()
    } catch (error) {
      await recover(error instanceof Error ? error : new Error("Plugin installation failed"))
    }
  }
  if (activation) void (async () => {
    try {
      const payload = await client.payload(preview.transactionId, abort.signal)
      if (abort.signal.aborted) return
      deadline = await client.beginTrial(preview, abort.signal)
      if (abort.signal.aborted) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) { fail(expired()); return }
      phase = "trial"
      timer = setTimeout(() => {
        if (phase === "committing") { abort.abort(); void recover(expired()) }
        else if (phase === "trial") fail(expired())
      }, remaining)
      onFrame({ key, client, props: {
        payload, digest: preview.digest, activationKey: key, context: trialContext, active: false, title: "Plugin installation check",
        execute: async (request, signal) => {
          abort.signal.throwIfAborted(); signal.throwIfAborted()
          if (request.method !== "lifecycle.ready") throw new Error("This action is unavailable during installation")
          return null
        },
        onReady: () => { void ready() }, onError: fail,
      } })
    } catch (error) { fail(error instanceof Error ? error : new Error("Plugin trial failed")) }
  })()
  return () => { phase = "canceled"; clearTimeout(timer); abort.abort() }
}

export function PluginInstallTrial({ client, preview, activation, onComplete, onError }: {
  client: RuntimePluginClient; preview: PluginInstallPreview; activation: string; onComplete: () => void; onError: (error: Error) => void
}) {
  const key = `${activation}:trial:${preview.transactionId}:${preview.digest}:${preview.registryRevision}`
  const [frame, setFrame] = useState<TrialFrame | null>(null)
  const callbacks = useRef({ onComplete, onError })
  useLayoutEffect(() => { callbacks.current = { onComplete, onError } })
  useLayoutEffect(() => startTrial({ client, preview, activation, key, onFrame: setFrame,
    onComplete: () => callbacks.current.onComplete(), onError: (error) => callbacks.current.onError(error),
  }), [client, preview, activation, key])
  return <div role="status" className="flex flex-col gap-2">
    <p>Checking that {preview.manifest.name} starts correctly…</p>
    {activation && frame?.key === key && frame.client === client && <PluginFrame {...frame.props} />}
  </div>
}
