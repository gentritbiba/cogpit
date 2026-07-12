import type { ActiveSessionInfo, RunningProcess } from "./SessionRow"

/**
 * Count sessions that are actually running. File recency is intentionally not
 * used: the endpoint also returns historical sessions for quick reopening.
 */
export function countLiveSessions(
  sessions: ActiveSessionInfo[],
  processesBySession: Map<string, RunningProcess>,
): number {
  return sessions.reduce((count, session) => {
    if (session.isActive) return count + 1
    if (!processesBySession.has(session.sessionId)) return count
    return session.agentStatus === "completed" ? count : count + 1
  }, 0)
}
