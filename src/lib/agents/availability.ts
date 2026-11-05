import { useEffect, useSyncExternalStore } from "react"

import type { AgentKind } from "../../../shared/session/agent-descriptors"
import { deviceScopedKey } from "@/lib/device"
import { fetchProviderUpdates, type ProviderUpdateInfo } from "@/lib/providerUpdates"

/**
 * Which agent CLIs the active machine can run, from `/api/provider-updates`.
 * One copy per device and signed-in account, for the provider picker, the
 * not-installed notice, the sign-in command and the update banner. Another
 * machine's answer is never shown: the store is keyed by device scope, and an
 * answer that arrives after the scope changed is dropped.
 */

const snapshots = new Map<string, readonly ProviderUpdateInfo[]>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

/** The device scope availability is kept under; capture it before awaiting work that reports back. */
export function agentAvailabilityScope(): string {
  return deviceScopedKey("agent-availability")
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** Ask the active machine again; concurrent callers share one request. A failed check keeps the last answer. */
export function refreshAgentAvailability(): Promise<void> {
  const scope = agentAvailabilityScope()
  const pending = inFlight.get(scope)
  if (pending) return pending
  const request = fetchProviderUpdates()
    .then((next) => {
      if (agentAvailabilityScope() !== scope) return
      snapshots.set(scope, next)
      notify()
    }, () => undefined)
    .finally(() => { inFlight.delete(scope) })
  inFlight.set(scope, request)
  return request
}

/**
 * Replace one agent's entry under `scope`, the device the answer came from,
 * e.g. an update run's result. Never the active scope: that may be another
 * machine by the time the answer lands.
 */
export function replaceAgentAvailability(info: ProviderUpdateInfo, scope: string): void {
  const current = snapshots.get(scope)
  if (!current) return
  snapshots.set(scope, current.map((entry) => (entry.provider === info.provider ? info : entry)))
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const readSnapshot = () => snapshots.get(agentAvailabilityScope()) ?? null

/** Every agent's entry on the active machine, or null until its first check answers. */
export function useAgentAvailability(): readonly ProviderUpdateInfo[] | null {
  const current = useSyncExternalStore(subscribe, readSnapshot, readSnapshot)
  const scope = agentAvailabilityScope()
  useEffect(() => {
    if (!snapshots.has(scope)) void refreshAgentAvailability()
  }, [scope])
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

/** @internal test-only */
export function _resetAgentAvailabilityForTests(): void {
  snapshots.clear()
  inFlight.clear()
  listeners.clear()
}
