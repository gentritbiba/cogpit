import { createRoot } from "react-dom/client"
import { createPluginClient, type PluginContext } from "@cogpit/plugin-sdk"
import { RuntimePanel } from "./RuntimePanel.js"
import { createClickUpRuntimeStore } from "./runtimeStore.js"
import "./styles.css"

export interface ClickUpPluginEntry { port: MessagePort; context: PluginContext; assets: Readonly<Record<string, string>> }
export function mountClickUp({ port, context: initialContext }: ClickUpPluginEntry): () => void {
  const client = createPluginClient({ port, context: initialContext })
  const element = document.createElement("div")
  element.id = "root"
  document.body.append(element)
  const root = createRoot(element)
  let context = initialContext
  let store = createClickUpRuntimeStore(client)
  let disposed = false
  function render() {
    root.render(<RuntimePanel key={context.project?.id ?? "none"} client={client} context={context} store={store} />)
  }
  const unsubscribe = [
    client.onContextChange((next) => {
      if (next.project?.id !== context.project?.id) { store.dispose(); store = createClickUpRuntimeStore(client) }
      context = next
      render()
    }),
    client.onVisibilityChange((visible) => { context = { ...context, visible }; render() }),
  ]
  function dispose() {
    if (disposed) return
    disposed = true
    window.removeEventListener("pagehide", dispose)
    for (const stop of unsubscribe) stop()
    store.dispose()
    root.unmount()
    element.remove()
    client.dispose()
  }
  window.addEventListener("pagehide", dispose, { once: true })
  render()
  void client.ready().catch(dispose)
  return dispose
}

;(globalThis as typeof globalThis & { cogpitPlugin?: (entry: ClickUpPluginEntry) => void }).cogpitPlugin = mountClickUp
