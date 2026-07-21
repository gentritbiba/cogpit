import { shortPath, dirNameToPath, parseWorktreePath, truncate } from "@/lib/format"
import { sortSessionsByRecency } from "@/lib/sessionOrdering"
import type { ActiveSessionInfo, RunningProcess } from "./types"

/**
 * Best display title for a session. Teammate sessions rarely have readable
 * prompts (they start with a teammate-message envelope), so their member name
 * is the clearest label.
 */
export function sessionTitle(s: ActiveSessionInfo, customName?: string): string {
  const isTeammate = !!(s.teamName && s.agentName)
  return customName || truncate(
    s.aiTitle || (isTeammate ? s.agentName! : "") || s.lastUserMessage || s.firstUserMessage || s.slug || s.sessionId,
    50,
  )
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

/**
 * How many leading rows a group shows before "Show N more". Extends past
 * baseCount when a live session would otherwise be hidden below the fold.
 */
export function visibleRowCount(
  sessions: ActiveSessionInfo[],
  procBySession: Map<string, RunningProcess>,
  baseCount: number,
): number {
  let lastLiveIndex = -1
  sessions.forEach((s, i) => {
    if (isSessionLive(s, procBySession)) lastLiveIndex = i
  })
  return Math.max(baseCount, lastLiveIndex + 1)
}
