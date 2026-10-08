import { join } from "node:path"
import { getDataRoot } from "../config"
import { OrchestrationStore } from "./store"

let current: { root: string; store: OrchestrationStore } | undefined
let pruning: ReturnType<typeof setInterval> | undefined
const disposers = new Set<() => void>()
export function beforeOrchestrationClose(dispose: () => void): () => void { disposers.add(dispose); return () => disposers.delete(dispose) }
export function orchestrationStore(): OrchestrationStore {
  const root = process.env.COGPIT_ORCHESTRATION_ROOT || getDataRoot()
  if (!current || current.root !== root) {
    closeOrchestrationStore()
    current = { root, store: new OrchestrationStore(join(root, "orchestration", "state.sqlite")) }
    current.store.prunePayloads()
    pruning = setInterval(() => { current?.store.prunePayloads() }, 24 * 60 * 60 * 1000)
    pruning.unref()
  }
  return current.store
}
export function closeOrchestrationStore(): void { clearInterval(pruning); pruning = undefined; for (const dispose of disposers) dispose(); disposers.clear(); current?.store.close(); current = undefined }
