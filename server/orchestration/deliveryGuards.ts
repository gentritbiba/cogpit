import type { TriggerOccurrence } from "../../shared/contracts/triggers"
import type { StoredCommand } from "./store"

/**
 * Consumer checks a trigger's queued command must pass at authorization and
 * again just before it reaches the agent: work that began outside Cogpit,
 * input the agent is waiting for, an archived session. Registered per
 * occurrence kind. An occurrence recorded as guarded is held when its kind's
 * guard is not registered (after a restart, before its consumer loaded).
 */

export type DeliveryVerdict = { allow: true } | { allow: false; disposition: "held" | "cancelled"; reason: string }
export type DeliveryGuard = (occurrence: TriggerOccurrence, command: StoredCommand) => Promise<DeliveryVerdict>

/** A delivery a guard refused before any provider I/O; the dispatcher settles the command with it. */
export class DeliveryRefused extends Error {
  constructor(readonly disposition: "held" | "cancelled", reason: string) { super(reason); this.name = "DeliveryRefused" }
}

const guards = new Map<string, DeliveryGuard>()

export function registerTriggerDeliveryGuard(kind: string, guard: DeliveryGuard): () => void {
  guards.set(kind, guard)
  return () => { if (guards.get(kind) === guard) guards.delete(kind) }
}

const MISSING: DeliveryVerdict = { allow: false, disposition: "held", reason: "This task's delivery check is not available yet; review and resume it" }

/** The verdict for a command a guarded occurrence admitted; allows anything else. */
export async function checkTriggerDelivery(occurrence: TriggerOccurrence | null, command: StoredCommand): Promise<DeliveryVerdict> {
  if (!occurrence?.guarded) return { allow: true }
  const guard = guards.get(occurrence.kind)
  if (!guard) return MISSING
  try {
    return await guard(occurrence, command)
  } catch (error) {
    return { allow: false, disposition: "held", reason: error instanceof Error ? error.message : "This task's delivery check failed" }
  }
}
