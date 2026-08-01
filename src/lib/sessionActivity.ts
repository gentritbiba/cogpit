/**
 * Whether a session is actually doing something right now.
 *
 * `isSessionLive` asks whether *this* Cogpit owns the session — it needs
 * `isActive` (native Codex) or an OS process mapped to the session id. That is
 * the right question for "can I kill this PID", but the wrong one for "is this
 * agent working": a remote device, a second Cogpit instance, or any session
 * started outside this process reports `sessionId: null` for every process, and
 * would show a whole screen of busy agents as finished.
 *
 * `agentStatus` is derived from the session JSONL tail, so it is observable by
 * any server. Pairing it with file recency keeps it honest — a session
 * abandoned mid-tool-call decays out of "working" instead of claiming to run
 * forever.
 */

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

/** True when the session file changed within the freshness window. */
export function isRecentlyActive(session: ActiveSessionInfo, now: number = Date.now()): boolean {
  const stamp = Date.parse(session.lastActivityAt || session.lastModified)
  return Number.isFinite(stamp) && now - stamp < RECENT_ACTIVITY_MS
}

/**
 * True when the session is owned by this Cogpit, or its status and file
 * recency agree that something is happening.
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
 * Deliberately ignores file recency, unlike {@link isSessionActive}. A
 * recency-based gate decays to false purely by the clock advancing, which stops
 * the very poll that would refresh those timestamps; polling then never
 * resumes. This predicate only changes when new data arrives, so it cannot
 * switch itself off.
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
