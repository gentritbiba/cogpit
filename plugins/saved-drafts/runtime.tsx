import { useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { createPluginClient, type PluginClientOptions } from "@cogpit/plugin-sdk"
import type { DraftList } from "@cogpit/plugin-contracts"
import { SavedDraftsPanel } from "./SavedDraftsPanel.js"
import "./styles.css"

type Client = ReturnType<typeof createPluginClient>
export function SavedDraftsWorkspace({ client }: { client: Client }) {
  const [state, setState] = useState<DraftList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const current = useRef(state)
  current.current = state
  const pending = useRef(false)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const reload = useCallback(async (cursor?: string) => {
    const request = ++sequence.current
    try {
      const next = await client.drafts.list(cursor)
      if (!mounted.current || request !== sequence.current) return
      setState((old) => cursor && old?.token === next.token ? { ...next, items: [...old.items, ...next.items.filter((entry) => !old.items.some((item) => item.id === entry.id))] } : next)
    } catch (failure) {
      if (mounted.current && request === sequence.current) setError(failure instanceof Error ? failure.message : "Saved drafts is unavailable. Open a composer and try again.")
    }
  }, [client])
  useEffect(() => {
    mounted.current = true
    void reload()
    const stop = client.onDraftsChange(() => { void reload() })
    return () => { mounted.current = false; stop() }
  }, [client, reload])
  async function perform(action: (token: string) => Promise<unknown>) {
    if (pending.current) throw new Error("Wait for the current action to finish")
    const token = current.current?.token
    if (!token) { await reload(); throw new Error("Open a composer and refresh Saved drafts") }
    pending.current = true; setBusy(true); setError(null)
    try { await action(token) }
    catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "The draft could not be updated")
      throw failure
    } finally {
      pending.current = false
      if (mounted.current) { setBusy(false); await reload() }
    }
  }
  const ignore = (action: (token: string) => Promise<unknown>) => { void perform(action).catch(() => {}) }
  return <SavedDraftsPanel items={state?.items ?? []} error={error || state?.error} corrupt={state?.corrupt} pendingUpload={state?.pendingUpload} busy={busy} hasMore={Boolean(state?.next)}
    onLoadMore={() => { void reload(state?.next) }} onCapture={() => ignore((token) => client.drafts.capture(token, true))}
    onRestore={(id, mode) => perform((token) => client.drafts.restore(token, id, mode))}
    onRemove={(id) => ignore((token) => client.drafts.remove(token, id))} onBackup={() => perform((token) => client.drafts.backup(token))}
    onRetry={() => ignore((token) => client.drafts.recover(token, "retry"))} onReset={() => ignore((token) => client.drafts.recover(token, "reset"))}
    onDismissUpload={() => ignore((token) => client.drafts.recover(token, "dismissUpload"))} />
}

export function mountSavedDrafts(options: PluginClientOptions): () => void {
  const client = createPluginClient(options)
  const element = document.createElement("div")
  document.body.append(element)
  const root = createRoot(element)
  root.render(<SavedDraftsWorkspace client={client} />)
  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true; root.unmount(); element.remove(); client.dispose()
    window.removeEventListener("pagehide", dispose)
  }
  window.addEventListener("pagehide", dispose, { once: true })
  void client.ready().catch(dispose)
  return dispose
}
Object.assign(globalThis, { cogpitPlugin: mountSavedDrafts })
