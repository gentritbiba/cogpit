import { getDataRoot } from "../config"
import { createInstanceRuntime } from "./instanceRuntime"
import { providerInstances } from "./instanceConfigurations"
import type { AgentRuntime } from "./runtimeTypes"

const cache = new Map<string, AgentRuntime>()
export function instanceRuntimes(): AgentRuntime[] {
  return providerInstances().map((instance) => {
    const key = JSON.stringify([instance.id, instance.homeDir, instance.agent])
    let runtime = cache.get(key)
    if (!runtime) { runtime = createInstanceRuntime(instance, process.env.COGPIT_ORCHESTRATION_ROOT || getDataRoot()); cache.set(key, runtime) }
    return runtime
  })
}
export async function removeInstanceRuntime(id: string): Promise<void> { for (const [key, runtime] of cache) if (runtime.instanceId === id) { await runtime.shutdown(); cache.delete(key) } }
