import { createRoot } from "react-dom/client"
import { createPluginClient, type PluginContext } from "@cogpit/plugin-sdk"
import type { WorktreeSetupIntegrationRequest } from "@cogpit/plugin-contracts"
import type { WorktreeSetupScripts, WorktreeSetupSnapshot } from "@cogpit/plugin-integrations/worktreeSetup"
import { WorktreeSetupPanel, type WorktreeSetupApi } from "./WorktreeSetupPanel.js"
import "./styles.css"

type Request = WorktreeSetupIntegrationRequest extends infer R ? R extends unknown ? Omit<R, "integration"> : never : never

export interface WorktreeSetupPluginEntry { port: MessagePort; context: PluginContext; assets: Readonly<Record<string, string>> }
export function mountWorktreeSetup({ port, context: initialContext }: WorktreeSetupPluginEntry): () => void {
  const client = createPluginClient({ port, context: initialContext })
  const element = document.createElement("div"); element.id = "root"; element.className = "h-full"; document.body.append(element)
  const root = createRoot(element)
  async function call<T>(input: Request, signal?: AbortSignal): Promise<T> {
    const result = await client.integrations.request({ integration: "worktreeSetup", ...input } as WorktreeSetupIntegrationRequest, { signal })
    if (!result.ok) throw new Error(result.error.message)
    return result.data as unknown as T
  }
  const api: WorktreeSetupApi = {
    snapshot: (signal) => call<WorktreeSetupSnapshot>({ operation: "snapshot" }, signal),
    scripts: async (signal) => (await call<WorktreeSetupScripts>({ operation: "scripts" }, signal)).scripts,
    propose: async (command, timeoutMs) => { await call({ operation: "propose", command, timeoutMs }) },
    act: (operationId, action) => call<WorktreeSetupSnapshot>({ operation: "act", operationId, action }),
  }
  let context = initialContext, disposed = false
  const render = () => root.render(<WorktreeSetupPanel key={context.project?.id ?? "none"} api={api} active={context.visible} />)
  const unsubscribe = [
    client.onContextChange(next => { context = next; render() }),
    client.onVisibilityChange(visible => { context = { ...context, visible }; render() }),
  ]
  function dispose() {
    if (disposed) return
    disposed = true
    window.removeEventListener("pagehide", dispose)
    for (const stop of unsubscribe) stop()
    root.unmount(); element.remove(); client.dispose()
  }
  window.addEventListener("pagehide", dispose, { once: true })
  render()
  void client.ready().catch(dispose)
  return dispose
}
;(globalThis as typeof globalThis & { cogpitPlugin?: (entry: WorktreeSetupPluginEntry) => void }).cogpitPlugin = mountWorktreeSetup
