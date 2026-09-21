import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createPluginClient, type PluginClient, type PluginContext } from "@cogpit/plugin-sdk"
import { GitHubPanel } from "./GitHubPanel.js"
import { createGitHubStore, GitHubStoreProvider, type GitHubStore } from "./githubStore.js"
import "./styles.css"

export interface GitHubPluginEntry { port: MessagePort; context: PluginContext; assets: Readonly<Record<string, string>> }
function RuntimeGitHubPanel({ client, context, store }: { client: PluginClient; context: PluginContext; store: GitHubStore }) {
  const [error, setError] = useState<string | null>(null)
  const action = (work: () => Promise<unknown>, message: string) => {
    setError(null)
    void work().catch((failure: unknown) => {
      if (failure && typeof failure === "object" && "code" in failure && ["CANCELED", "DISPOSED"].includes(String(failure.code))) return
      setError(message)
    })
  }
  return <GitHubStoreProvider value={store}>
    {error && <p role="alert" className="border-b p-3 text-xs text-destructive">{error}</p>}
    <GitHubPanel active={context.visible} context={{ projectKey: context.project?.id ?? null,
      openSession: handle => action(() => client.navigation.openSession(handle), "Unable to open that session."),
      composePrompt: text => action(() => client.composer.append(text), "Unable to add this issue to your draft."),
    }} openExternal={url => action(() => client.navigation.openExternal(url), "Unable to open that link.")} />
  </GitHubStoreProvider>
}
export function mountGitHub({ port, context: initialContext }: GitHubPluginEntry): () => void {
  const client = createPluginClient({ port, context: initialContext })
  const element = document.createElement("div"); element.id = "root"; document.body.append(element)
  const root = createRoot(element)
  let context = initialContext, store = createGitHubStore(client), disposed = false
  const render = () => {
    root.render(<RuntimeGitHubPanel key={context.project?.id ?? "none"} client={client} context={context} store={store} />)
  }
  const unsubscribe = [
    client.onContextChange(next => {
      if (next.project?.id !== context.project?.id) { store.dispose(); store = createGitHubStore(client) }
      context = next; render()
    }),
    client.onVisibilityChange(visible => { context = { ...context, visible }; render() }),
  ]
  function dispose() {
    if (disposed) return
    disposed = true; window.removeEventListener("pagehide", dispose)
    for (const stop of unsubscribe) stop()
    store.dispose(); root.unmount(); element.remove(); client.dispose()
  }
  window.addEventListener("pagehide", dispose, { once: true })
  render(); void client.ready().catch(dispose)
  return dispose
}
;(globalThis as typeof globalThis & { cogpitPlugin?: (entry: GitHubPluginEntry) => void }).cogpitPlugin = mountGitHub
