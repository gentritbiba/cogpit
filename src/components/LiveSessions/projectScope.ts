import { descriptorForDirName } from "@/lib/agents"
import { dirNameToPath, parseWorktreePath } from "@/lib/format"
import { sortSessionsByRecency } from "../../../shared/session-ordering"
import { foldCrewRows } from "./crew"
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
  /** Distinct worktrees the listed sessions ran in. */
  worktrees: number
  /** Listed sessions that started a crew of their own. */
  crews: number
}

/** Where a group's new sessions start: the main checkout, even when only its worktrees have sessions listed. */
function projectHome(primary: ActiveSessionInfo): { dirName: string; cwd?: string } {
  const worktree = parseWorktreePath(primary.cwd ?? dirNameToPath(primary.dirName))
  if (!worktree) return { dirName: primary.dirName, cwd: primary.cwd }
  const { parentPath } = worktree
  return { dirName: descriptorForDirName(primary.dirName).dirName.encode(parentPath), cwd: parentPath }
}

function worktreeCount(group: ActiveSessionInfo[]): number {
  const names = group.map((s) => parseWorktreePath(s.cwd ?? dirNameToPath(s.dirName))?.worktreeName)
  return new Set(names.filter(Boolean)).size
}

/**
 * One option per project the listed sessions belong to. Pass the sessions a
 * list places on its own: a crew member counts toward its root's project.
 */
export function projectScopeOptions(
  sessions: ActiveSessionInfo[],
  procBySession: Map<string, RunningProcess>,
  projectNames: Record<string, string>,
  needsYou: ReadonlySet<string>,
  crewOf: ReadonlyMap<string, readonly ActiveSessionInfo[]> = new Map(),
): ProjectScopeOption[] {
  return [...groupByProject(sessions).entries()].map(([key, group]) => {
    const primary = primaryProjectSession(group)!
    const home = projectHome(primary)
    return {
      key,
      customName: projectNames[home.dirName],
      ...home,
      dirNames: [...new Set(group.map((s) => s.dirName))],
      total: group.length,
      live: countLiveSessions(group, procBySession),
      needsYou: group.filter((s) => needsYou.has(s.sessionId)).length,
      worktrees: worktreeCount(group),
      crews: group.filter((s) => crewOf.has(s.sessionId)).length,
    }
  })
}

/**
 * The sessions in one project. Grouped, a crew follows its root: members
 * come along from other folders, and a member here whose root is elsewhere
 * stays, on its own.
 */
export function scopeSessions(
  sessions: ActiveSessionInfo[],
  scope: string | null,
  grouped = false,
): ActiveSessionInfo[] {
  if (scope === null) return sessions
  if (!grouped) return sessions.filter((s) => sessionGroupKey(s) === scope)
  const { topLevel, crewOf } = foldCrewRows(sessions)
  const scoped = new Set<ActiveSessionInfo>()
  for (const unit of topLevel) {
    if (sessionGroupKey(unit) !== scope) continue
    scoped.add(unit)
    for (const member of crewOf.get(unit.sessionId) ?? []) scoped.add(member)
  }
  for (const members of crewOf.values()) {
    for (const member of members) if (sessionGroupKey(member) === scope) scoped.add(member)
  }
  return sessions.filter((s) => scoped.has(s))
}

/** Listed sessions first, then any older ones not already present, newest first. */
export function mergeSessions(listed: ActiveSessionInfo[], older: ActiveSessionInfo[]): ActiveSessionInfo[] {
  if (older.length === 0) return listed
  const seen = new Set(listed.map((s) => s.sessionId))
  const extra = older.filter((s) => !seen.has(s.sessionId))
  return extra.length === 0 ? listed : sortSessionsByRecency([...listed, ...extra])
}
