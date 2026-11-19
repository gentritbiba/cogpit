import type { InstalledPlugin } from "../../shared/contracts/plugins"
import type { useRuntimeContributions } from "./RuntimePluginContributions"

export type RuntimeContributions = NonNullable<ReturnType<typeof useRuntimeContributions>>

/** Runs `run` with a short lease on `plugin` for the open project, revoked afterwards. */
export async function withLease<T>(runtime: RuntimeContributions, plugin: InstalledPlugin, signal: AbortSignal, run: (leaseId: string) => Promise<T>): Promise<T> {
  const lease = await runtime.client.lease(plugin.id, runtime.project?.id ?? null, crypto.randomUUID(), signal, runtime.project ? runtime.workspacePath : null)
  try { return await run(lease.id) }
  finally { void runtime.client.revokeLease(lease.id).catch(() => {}) }
}
