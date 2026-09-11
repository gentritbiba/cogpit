import { shortPath, dirNameToPath, parseWorktreePath, truncate } from "@/lib/format"
import { sortSessionsByRecency } from "../../../shared/session-ordering"
import type { ActiveSessionInfo, RunningProcess } from "./types"

/**
 * Best display title for a session. Teammate sessions rarely have readable
 * prompts (they start with a teammate-message envelope), so their member name
 * is the clearest label.
 */
export function sessionTitle(s: ActiveSessionInfo, customName?: string): string {
  return customName || truncate(sessionHeadline(s), 50)
}

/** The untruncated title, for surfaces with room to wrap it. */
export function sessionHeadline(s: ActiveSessionInfo, customName?: string): string {
  const teammateName = s.teamName && s.agentName ? s.agentName : ""
  return customName
    || s.aiTitle
    || teammateName
    || s.lastUserMessage
    || s.firstUserMessage
    || s.slug
    || s.sessionId
}

/**
 * Teammate sessions nest under their lead when the lead is in the same list;
 * a teammate whose lead is elsewhere stays top-level so it is never lost.
 */
export function splitTeammates(sessions: ActiveSessionInfo[]): {
  topLevelSessions: ActiveSessionInfo[]
  teammatesByLead: Map<string, ActiveSessionInfo[]>
} {
  const ids = new Set(sessions.map((session) => session.sessionId))
  const teammatesByLead = new Map<string, ActiveSessionInfo[]>()
  const topLevelSessions: ActiveSessionInfo[] = []
  for (const session of sessions) {
    const lead = session.teamLeadSessionId
    if (lead && lead !== session.sessionId && ids.has(lead)) {
      const teammates = teammatesByLead.get(lead)
      if (teammates) teammates.push(session)
      else teammatesByLead.set(lead, [session])
    } else {
      topLevelSessions.push(session)
    }
  }
  return { topLevelSessions, teammatesByLead }
}

/** The directory a group's new sessions belong to: the checkout itself before any worktree. */
export function primaryProjectSession(sessions: ActiveSessionInfo[]): ActiveSessionInfo | undefined {
  return sessions.find((session) => !parseWorktreePath(session.cwd ?? dirNameToPath(session.dirName)))
    ?? sessions[0]
}

/** Label used when a session has no resolvable project path. */
export const UNKNOWN_PROJECT_LABEL = "Unknown project"

/** Resolve a project grouping key from a raw filesystem path — worktree paths map to their parent. */
export function projectGroupKey(rawPath: string): string {
  const wt = parseWorktreePath(rawPath)
  return shortPath(wt ? wt.parentPath : rawPath, 2) || UNKNOWN_PROJECT_LABEL
}

/** Resolve the grouping key for a session. Empty cwd falls back to the dirName-derived path. */
export function sessionGroupKey(s: ActiveSessionInfo): string {
  return projectGroupKey(s.cwd || dirNameToPath(s.dirName))
}

/** What an archived row's mark says: the user's own action or the idle rule. */
export function archivedReasonLabel(reason: ActiveSessionInfo["archivedReason"]): string {
  return reason === "inactive" ? "Archived after two weeks without activity" : "Archived"
}

/** The sessions the sidebar lists: archived ones only when the user asked to see them. */
export function listedSessions(sessions: ActiveSessionInfo[], showArchived: boolean): ActiveSessionInfo[] {
  if (showArchived) return sessions
  return sessions.filter((s) => !s.archived)
}

/** Group sessions by project path for compact display, sorted newest-first. */
export function groupByProject(sessions: ActiveSessionInfo[]): Map<string, ActiveSessionInfo[]> {
  const sorted = sortSessionsByRecency(sessions)
  const groups = new Map<string, ActiveSessionInfo[]>()
  for (const s of sorted) {
    const key = sessionGroupKey(s)
    const list = groups.get(key)
    if (list) list.push(s)
    else groups.set(key, [s])
  }
  return groups
}

/**
 * True when a session is actively running — native app-server activity, or a
 * tracked OS process that hasn't reached "completed".
 */
export function isSessionLive(
  s: ActiveSessionInfo,
  procBySession: Map<string, RunningProcess>,
): boolean {
  if (s.isActive) return true
  if (!procBySession.has(s.sessionId)) return false
  return s.agentStatus !== "completed"
}
