/**
 * What the Mission Control home shows, worked out from data the app already
 * polls: every request blocked on the user in one queue, and the sessions the
 * user started with their crews, recent ones by default and any of them by
 * search.
 */

import type { MissionControlPermission, MissionControlQuestion } from "../../../shared/contracts/missionControl"
import type { MissionControlElicitation, MissionControlUserDialog } from "../../../shared/contracts/agentPrompts"
import { getSessionRecencyMs } from "../../../shared/session-ordering"
import { countCrew, crewActivityAt, foldCrewRows, type CrewCounts, type MemberState, type MemberStatus } from "@/components/LiveSessions/crew"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"

export type HomeRequest =
  | { kind: "permission"; sessionId: string; since: number; request: MissionControlPermission }
  | { kind: "question"; sessionId: string; since: number; request: MissionControlQuestion }
  | { kind: "elicitation"; sessionId: string; since: number; request: MissionControlElicitation }
  | { kind: "dialog"; sessionId: string; since: number; request: MissionControlUserDialog }
  /** A plan the agent's own CLI reviews: opening the session is the answer. */
  | { kind: "plan"; sessionId: string; since: number }
  /** A permission a hook deferred: resuming the session evaluates it again. */
  | { kind: "deferred"; sessionId: string; since: number }

export interface HomePending {
  permissionsBySession: ReadonlyMap<string, readonly MissionControlPermission[]>
  questionsBySession: ReadonlyMap<string, readonly MissionControlQuestion[]>
  elicitationsBySession: ReadonlyMap<string, readonly MissionControlElicitation[]>
  dialogsBySession: ReadonlyMap<string, readonly MissionControlUserDialog[]>
  awaitingPlan: ReadonlySet<string>
}

/** Every request blocked on the user, the longest waiting first. */
export function homeQueue(
  pending: HomePending,
  sessions: readonly ActiveSessionInfo[],
  canAct: (sessionId: string) => boolean = () => true,
): HomeRequest[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const listedSince = (sessionId: string) => {
    const session = byId.get(sessionId)
    return session ? getSessionRecencyMs(session) : Date.now()
  }
  const queue: HomeRequest[] = []
  for (const [sessionId, requests] of pending.permissionsBySession) {
    for (const request of requests) queue.push({ kind: "permission", sessionId, since: request.timestamp, request })
  }
  for (const [sessionId, requests] of pending.questionsBySession) {
    for (const request of requests) queue.push({ kind: "question", sessionId, since: request.askedAt, request })
  }
  for (const [sessionId, requests] of pending.elicitationsBySession) {
    for (const request of requests) queue.push({ kind: "elicitation", sessionId, since: request.askedAt, request })
  }
  for (const [sessionId, requests] of pending.dialogsBySession) {
    for (const request of requests) queue.push({ kind: "dialog", sessionId, since: request.askedAt, request })
  }
  for (const sessionId of pending.awaitingPlan) queue.push({ kind: "plan", sessionId, since: listedSince(sessionId) })
  for (const session of sessions) {
    if (session.agentStatus === "deferred" && !session.archived) {
      queue.push({ kind: "deferred", sessionId: session.sessionId, since: listedSince(session.sessionId) })
    }
  }
  return queue.filter((request) => canAct(request.sessionId)).sort((a, b) => a.since - b.since)
}

/** The request's own id, for keys and for answering it. */
export function homeRequestId(request: HomeRequest): string {
  switch (request.kind) {
    case "permission": return request.request.requestId
    case "question": return request.request.toolUseId
    case "elicitation":
    case "dialog": return request.request.requestId
    default: return `${request.kind}:${request.sessionId}`
  }
}

export interface HomeCrewMember {
  member: ActiveSessionInfo
  state: MemberState
}

export interface HomeSession {
  session: ActiveSessionInfo
  /** The session's own state, before its crew's. */
  state: MemberState
  /** Everyone in its crew: who needs the user, then who is working, then the rest, newest first within each. */
  crew: HomeCrewMember[]
  counts: CrewCounts | null
  activityAt: string
  /** The newest pull request the session or its crew opened. */
  landed?: { number: number; title: string | null; url: string; by: ActiveSessionInfo }
}

const WEEK_MS = 7 * 86_400_000
const MIN_SESSIONS = 3
const MAX_SESSIONS = 30
const MAX_MATCHES = 50
const STATE_ORDER: Record<MemberState, number> = { "needs-you": 0, working: 1, done: 2 }

/** Every session the user started, each with its crew, newest crew activity first. */
export function homeSessionRows(
  sessions: readonly ActiveSessionInfo[],
  statusOf: (member: ActiveSessionInfo) => MemberStatus,
): HomeSession[] {
  const listed = sessions.filter((session) => !session.archived && !(session.teamName && session.agentName))
  const { topLevel, crewOf } = foldCrewRows(listed)
  return topLevel.map((session): HomeSession => {
    const members = crewOf.get(session.sessionId) ?? []
    const activityAt = members.length ? crewActivityAt(session, members) : session.lastActivityAt || session.lastModified
    const latest = [session, ...members]
      .flatMap((by) => (by.pullRequests ?? []).map((pullRequest) => ({ pullRequest, by })))
      .sort((a, b) => Date.parse(b.pullRequest.timestamp) - Date.parse(a.pullRequest.timestamp))[0]
    return {
      session,
      state: statusOf(session).state,
      crew: members
        .map((member) => ({ member, state: statusOf(member).state }))
        .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || getSessionRecencyMs(b.member) - getSessionRecencyMs(a.member)),
      counts: members.length ? countCrew(members, statusOf) : null,
      activityAt,
      ...(latest && { landed: { number: latest.pullRequest.number, title: latest.pullRequest.title, url: latest.pullRequest.url, by: latest.by } }),
    }
  }).sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt))
}

/**
 * The sessions the home lists without a search: those active in the last
 * week, never fewer than three and never more than a page's worth.
 */
export function homeSessions(rows: readonly HomeSession[], now = Date.now()): HomeSession[] {
  const recent = rows.filter((entry) => now - Date.parse(entry.activityAt) < WEEK_MS)
  return (recent.length >= MIN_SESSIONS ? recent : rows.slice(0, MIN_SESSIONS)).slice(0, MAX_SESSIONS)
}

/**
 * The folders of the newest sessions, each once however many agents encode
 * it, so the next session can start in one of them with a click. A session
 * whose folder is unknown cannot be offered: its name would be a guess.
 */
export function recentHomeProjects<T extends { cwd?: string }>(
  rows: readonly HomeSession[],
  projectOf: (session: ActiveSessionInfo) => T,
  limit = 6,
): T[] {
  const projects: T[] = []
  const seen = new Set<string>()
  for (const entry of rows) {
    const project = projectOf(entry.session)
    if (!project.cwd || seen.has(project.cwd)) continue
    seen.add(project.cwd)
    projects.push(project)
    if (projects.length === limit) break
  }
  return projects
}

/**
 * The sessions matching every word of the query somewhere in the text the
 * caller supplies for them: title, project, branch, crew member names, last
 * message. Order is kept, so the newest match comes first.
 */
export function searchHomeSessions(
  rows: readonly HomeSession[],
  query: string,
  textOf: (entry: HomeSession) => ReadonlyArray<string | null | undefined>,
): HomeSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return rows.filter((entry) => {
    const haystack = textOf(entry).filter(Boolean).join("\n").toLowerCase()
    return words.every((word) => haystack.includes(word))
  }).slice(0, MAX_MATCHES)
}
