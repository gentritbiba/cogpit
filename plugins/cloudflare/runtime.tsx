import { createRoot } from "react-dom/client"
import { createPluginClient, type PluginContext } from "@cogpit/plugin-sdk"
import { createAccountStore } from "./accountStore.js"
import { CloudflarePanel } from "./CloudflarePanel.js"
import { CloudflareProvider, createCloudflareStore, type CloudflareResponse } from "./cloudflareStore.js"
import "./styles.css"

export interface CloudflarePluginEntry { port: MessagePort; context: PluginContext; assets: Readonly<Record<string, string>> }
export function mountCloudflare({ port, context: initialContext }: CloudflarePluginEntry): () => void {
  const client = createPluginClient({ port, context: initialContext })
  const element = document.createElement("div"); element.id = "root"; document.body.append(element)
  const root = createRoot(element)
  const makeStore = () => createCloudflareStore(async (_projectKey, input, signal) => {
    const result = await client.integrations.request(input, { signal })
    signal.throwIfAborted()
    if (!result.ok) throw { code: result.error.code, error: result.error.message }
    return result.data as unknown as CloudflareResponse
  })
  const makeAccountStore = () => createAccountStore({
    status: signal => client.connections.status("cloudflare", { signal }),
    workers: signal => client.connections.request("cloudflare", "workers", {}, { signal }),
  })
  let context = initialContext, store = makeStore(), account = makeAccountStore(), disposed = false
  const openExternal = (url: string) => client.navigation.openExternal(url)
  function render() {
    root.render(<CloudflareProvider value={store}><CloudflarePanel key={context.project?.id ?? "none"} context={{ projectPath: context.project?.id ?? null }} active={context.visible} openExternal={openExternal} account={account} /></CloudflareProvider>)
  }
  const unsubscribe = [
    client.onContextChange(next => { store.dispose(); account.dispose(); store = makeStore(); account = makeAccountStore(); context = next; render() }),
    client.onVisibilityChange(visible => { context = { ...context, visible }; render() }),
  ]
  function dispose() {
    if (disposed) return
    disposed = true
    window.removeEventListener("pagehide", dispose)
    for (const stop of unsubscribe) stop()
    store.dispose(); account.dispose(); root.unmount(); element.remove(); client.dispose()
  }
  window.addEventListener("pagehide", dispose, { once: true })
  render()
  void client.ready().catch(dispose)
  return dispose
}
;(globalThis as typeof globalThis & { cogpitPlugin?: (entry: CloudflarePluginEntry) => void }).cogpitPlugin = mountCloudflare
