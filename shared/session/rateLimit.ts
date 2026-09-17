// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Reading a runtime's rate-limit report into the one fact the UI acts on: the
 * session is blocked, and here is what can still be done about it.
 *
 * The interesting half is what *cannot* be done. A CLI may be able to carry the
 * session past a spent allowance at lower priority, but only from its own
 * terminal UI, so Cogpit can offer to hand the session over and nothing more.
 * Which agents that applies to is `capabilities.lowPriorityInTerminal`, never a
 * name matched here.
 */
import { descriptorFor } from "./agent-descriptors"
import type { AgentKind } from "./types"

/**
 * The shorter allowance, the only one a lower-priority hand-off can rescue —
 * the mode spends the weekly allowance to get past this one.
 */
export const SESSION_LIMIT = "five_hour"

/** A turn the runtime refused, and the way out of it if there is one. */
export interface RateLimitBlock {
  /** Which allowance ran out, verbatim from the runtime; null if it named none. */
  limit: string | null
  /** Epoch seconds when the allowance refills; null if the runtime sent none. */
  resetsAt: number | null
  /** Whether continuing at lower priority in a terminal would get past this block. */
  lowPriority: boolean
}

/**
 * Null whenever the session is still being served — including the warning the
 * runtime sends as an allowance runs low, which is the usage widget's business
 * and not cause for a banner.
 */
export function readRateLimitBlock(kind: AgentKind, info: unknown): RateLimitBlock | null {
  if (typeof info !== "object" || info === null || Array.isArray(info)) return null
  const report = info as { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown }
  if (report.status !== "rejected") return null

  const limit = typeof report.rateLimitType === "string" ? report.rateLimitType : null
  const resetsAt = typeof report.resetsAt === "number" && Number.isFinite(report.resetsAt)
    ? report.resetsAt
    : null

  return {
    limit,
    resetsAt,
    lowPriority: limit === SESSION_LIMIT && descriptorFor(kind).capabilities.lowPriorityInTerminal,
  }
}
