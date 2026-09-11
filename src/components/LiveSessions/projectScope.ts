import { sortSessionsByRecency } from "../../../shared/session-ordering"
import { countLiveSessions } from "./liveSessionSummary"
import { groupByProject, primaryProjectSession, sessionGroupKey } from "./sessionListView"
import type { ActiveSessionInfo, RunningProcess } from "./types"

/** One project the sidebar can focus on, as derived from the listed sessions. */
export interface ProjectScopeOption {
  /** Group key, shared with the project groups and stored as the chosen scope. */
  key: string
  customName?: string
  /** Where a new session in this project starts. */
  dirName: string
  cwd?: string
  /** Every directory whose sessions land in this group: worktrees and other agents' copies. */
  dirNames: string[]
  total: number
  live: number
  /** Sessions blocked on the user, so a focused sidebar still shows where else they are needed. */
  needsYou: number
}

export function projectScopeOptions(
  sessions: ActiveSessionInfo[],
  procBySession: Map<string, RunningProcess>,
  projectNames: Record<string, string>,
  needsYou: ReadonlySet<string>,
): ProjectScopeOption[] {
  return [...groupByProject(sessions).entries()].map(([key, group]) => {
    const primary = primaryProjectSession(group)!
    return {
      key,
      customName: projectNames[primary.dirName],
      dirName: primary.dirName,
      cwd: primary.cwd,
      dirNames: [...new Set(group.map((s) => s.dirName))],
      total: group.length,
      live: countLiveSessions(group, procBySession),
      needsYou: group.filter((s) => needsYou.has(s.sessionId)).length,
    }
  })
}

export function scopeSessions(sessions: ActiveSessionInfo[], scope: string | null): ActiveSessionInfo[] {
  if (scope === null) return sessions
  return sessions.filter((s) => sessionGroupKey(s) === scope)
}

/** Listed sessions first, then any older ones not already present, newest first. */
export function mergeSessions(listed: ActiveSessionInfo[], older: ActiveSessionInfo[]): ActiveSessionInfo[] {
  if (older.length === 0) return listed
  const seen = new Set(listed.map((s) => s.sessionId))
  const extra = older.filter((s) => !seen.has(s.sessionId))
  return extra.length === 0 ? listed : sortSessionsByRecency([...listed, ...extra])
}
