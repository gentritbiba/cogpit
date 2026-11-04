import { useEffect, useSyncExternalStore } from "react"

import type { AgentKind } from "../../../shared/session/agent-descriptors"
import { fetchProviderUpdates, type ProviderUpdateInfo } from "@/lib/providerUpdates"

/**
 * Which agent CLIs this server can run, from `/api/provider-updates`. One copy
 * for the whole renderer: the provider picker, the not-installed notice, the
 * sign-in action and the update banner all read it.
 */

let providers: readonly ProviderUpdateInfo[] | null = null
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: readonly ProviderUpdateInfo[]): void {
  providers = next
  for (const listener of listeners) listener()
}

/** Ask the server again; concurrent callers share one request. A failed check keeps the last answer. */
export function refreshAgentAvailability(): Promise<void> {
  inFlight ??= fetchProviderUpdates()
    .then(publish, () => undefined)
    .finally(() => { inFlight = null })
  return inFlight
}

/** Replace one agent's entry, e.g. with the answer an update run came back with. */
export function replaceAgentAvailability(info: ProviderUpdateInfo): void {
  if (providers) publish(providers.map((entry) => (entry.provider === info.provider ? info : entry)))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Every agent's entry, or null until the first check answers. */
export function useAgentAvailability(): readonly ProviderUpdateInfo[] | null {
  const current = useSyncExternalStore(subscribe, () => providers, () => providers)
  useEffect(() => {
    if (!providers) void refreshAgentAvailability()
  }, [])
  return current
}

/** One agent's entry from a snapshot, if the server reported it. */
export function agentAvailability(
  snapshot: readonly ProviderUpdateInfo[] | null,
  kind: AgentKind,
): ProviderUpdateInfo | undefined {
  return snapshot?.find((entry) => entry.provider === kind)
}

/** False only when the server has answered and found nothing to run; unknown counts as installed. */
export function isAgentInstalled(snapshot: readonly ProviderUpdateInfo[] | null, kind: AgentKind): boolean {
  return agentAvailability(snapshot, kind)?.installed ?? true
}

/** The binary the server spawns for an agent, when it has reported one. */
export function agentExecutable(kind: AgentKind): string | null {
  return agentAvailability(providers, kind)?.binaryPath ?? null
}

/** @internal test-only */
export function _resetAgentAvailabilityForTests(): void {
  providers = null
  inFlight = null
  listeners.clear()
}
