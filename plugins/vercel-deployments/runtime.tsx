import { createRoot } from "react-dom/client"
import { createPluginClient, type PluginContext } from "@cogpit/plugin-sdk"
import type { VercelBuildLogsResponse, VercelDeploymentsResponse } from "@cogpit/plugin-integrations"
import { VercelDeploymentsPanel } from "./VercelDeploymentsPanel.js"
import { createVercelDeploymentsStore, VercelDeploymentsProvider } from "./vercelDeploymentsStore.js"
import "./styles.css"

export interface VercelPluginEntry { port: MessagePort; context: PluginContext; assets: Readonly<Record<string, string>> }
export function mountVercel({ port, context: initialContext }: VercelPluginEntry): () => void {
  const client = createPluginClient({ port, context: initialContext })
  const element = document.createElement("div"); element.id = "root"; document.body.append(element)
  const root = createRoot(element)
  const makeStore = () => createVercelDeploymentsStore(async (_projectKey, input, signal) => {
    const result = await client.integrations.request(input, { signal })
    signal.throwIfAborted()
    if (!result.ok) throw { code: result.error.code, error: result.error.message }
    return result.data as unknown as VercelDeploymentsResponse | VercelBuildLogsResponse
  })
  let context = initialContext, store = makeStore(), disposed = false
  const openExternal = (url: string) => client.navigation.openExternal(url)
  function render() {
    document.documentElement.classList.toggle("dark", context.theme.mode === "dark")
    document.documentElement.classList.toggle("reduced-motion", context.reducedMotion)
    document.documentElement.lang = context.locale
    root.render(<VercelDeploymentsProvider value={store}><VercelDeploymentsPanel key={context.project?.id ?? "none"} context={{ projectPath: context.project?.id ?? null }} active={context.visible} openExternal={openExternal} /></VercelDeploymentsProvider>)
  }
  const unsubscribe = [
    client.onContextChange(next => { store.dispose(); store = makeStore(); context = next; render() }),
    client.onThemeChange(theme => { context = { ...context, theme }; render() }),
    client.onVisibilityChange(visible => { context = { ...context, visible }; render() }),
  ]
  function dispose() {
    if (disposed) return
    disposed = true
    window.removeEventListener("pagehide", dispose)
    for (const stop of unsubscribe) stop()
    store.dispose(); root.unmount(); element.remove(); client.dispose()
  }
  window.addEventListener("pagehide", dispose, { once: true })
  render()
  void client.ready().catch(dispose)
  return dispose
}
;(globalThis as typeof globalThis & { cogpitPlugin?: (entry: VercelPluginEntry) => void }).cogpitPlugin = mountVercel
