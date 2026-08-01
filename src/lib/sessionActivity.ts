/** Whether a session is actually doing something right now. */

import { isSessionLive } from "@/components/LiveSessions/sessionListView"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"

/** Statuses that mean the agent is mid-flight. */
export const WORKING_STATUSES: ReadonlySet<string> = new Set([
  "thinking",
  "tool_use",
  "processing",
  "compacting",
])

/** How recently the session file must have changed to corroborate a status. */
export const RECENT_ACTIVITY_MS = 120_000

export function isRecentlyActive(session: ActiveSessionInfo, now: number = Date.now()): boolean {
  const stamp = Date.parse(session.lastActivityAt || session.lastModified)
  return Number.isFinite(stamp) && now - stamp < RECENT_ACTIVITY_MS
}

/**
 * True when this Cogpit owns the session, or its status and file recency agree
 * that something is happening.
 *
 * Status + recency rather than `isSessionLive` alone, because a session owned by
 * another Cogpit or a remote device maps to no local PID and would render a
 * whole screen of busy agents as finished. `agentStatus` comes from the JSONL
 * tail so any server can observe it; recency keeps it honest when a session is
 * abandoned mid-tool-call.
 */
export function isSessionActive(
  session: ActiveSessionInfo,
  procBySession: Map<string, RunningProcess>,
  now: number = Date.now(),
): boolean {
  if (isSessionLive(session, procBySession)) return true
  if (session.agentStatus === "completed") return false
  if (!session.agentStatus) return false
  return isRecentlyActive(session, now)
}

/**
 * Whether any session might still be working — the gate for polling.
 *
 * Deliberately ignores recency, unlike {@link isSessionActive}: a recency-based
 * gate decays to false purely by the clock advancing, stopping the very poll
 * that would refresh those timestamps, and polling never resumes. This predicate
 * only changes when new data arrives, so it cannot switch itself off.
 */
export function hasUnfinishedWork(
  sessions: readonly ActiveSessionInfo[],
  procBySession: Map<string, RunningProcess>,
): boolean {
  return sessions.some((s) => {
    if (isSessionLive(s, procBySession)) return true
    if (!s.agentStatus) return false
    return s.agentStatus !== "completed"
  })
}
