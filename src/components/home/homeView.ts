/**
 * What the Mission Control home shows, worked out from data the app already
 * polls: every request blocked on the user in one queue, the sessions the
 * user started with their crews, and what landed today.
 */

import type { MissionControlPermission, MissionControlQuestion } from "../../../shared/contracts/missionControl"
import type { MissionControlElicitation, MissionControlUserDialog } from "../../../shared/contracts/agentPrompts"
import { getSessionRecencyMs } from "../../../shared/session-ordering"
import { countCrew, crewActivityAt, foldCrewRows, type CrewCounts, type MemberStatus } from "@/components/LiveSessions/crew"
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

export interface HomeSession {
  session: ActiveSessionInfo
  members: ActiveSessionInfo[]
  /** One state per member, in the order they were started. */
  cells: Array<MemberStatus["state"]>
  counts: CrewCounts | null
  activityAt: string
  /** The newest pull request the session or its crew opened. */
  landed?: { number: number; title: string | null; url: string; by: ActiveSessionInfo }
}

const DAY_MS = 86_400_000
const MIN_SESSIONS = 3
const MAX_SESSIONS = 8

/**
 * The sessions the user started, each with its crew: those active in the last
 * day, newest crew activity first, and never fewer than three.
 */
export function homeSessions(
  sessions: readonly ActiveSessionInfo[],
  statusOf: (member: ActiveSessionInfo) => MemberStatus,
  now = Date.now(),
): HomeSession[] {
  const listed = sessions.filter((session) => !session.archived && !(session.teamName && session.agentName))
  const { topLevel, crewOf } = foldCrewRows(listed)
  const placed = topLevel.map((session): HomeSession => {
    const members = crewOf.get(session.sessionId) ?? []
    const activityAt = members.length ? crewActivityAt(session, members) : session.lastActivityAt || session.lastModified
    const latest = [session, ...members]
      .flatMap((by) => (by.pullRequests ?? []).map((pullRequest) => ({ pullRequest, by })))
      .sort((a, b) => Date.parse(b.pullRequest.timestamp) - Date.parse(a.pullRequest.timestamp))[0]
    return {
      session,
      members,
      cells: members.map((member) => statusOf(member).state),
      counts: members.length ? countCrew(members, statusOf) : null,
      activityAt,
      ...(latest && { landed: { number: latest.pullRequest.number, title: latest.pullRequest.title, url: latest.pullRequest.url, by: latest.by } }),
    }
  }).sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt))
  const recent = placed.filter((entry) => now - Date.parse(entry.activityAt) < DAY_MS)
  return (recent.length >= MIN_SESSIONS ? recent : placed.slice(0, MIN_SESSIONS)).slice(0, MAX_SESSIONS)
}

export type LandedEvent =
  | { kind: "pr"; at: number; session: ActiveSessionInfo; number: number; title: string | null; url: string }
  | { kind: "finished"; at: number; session: ActiveSessionInfo }
  /** Sessions one session started within the same minute. */
  | { kind: "started"; at: number; parentId: string; sessions: ActiveSessionInfo[] }

function startOfToday(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const MAX_LANDED = 10

/**
 * Today's milestones, newest first: pull requests opened, crew members that
 * finished, and sessions a lead started, grouped by the minute it started them.
 */
export function landedToday(
  sessions: readonly ActiveSessionInfo[],
  statusOf: (member: ActiveSessionInfo) => MemberStatus,
  now = Date.now(),
): LandedEvent[] {
  const since = startOfToday(now)
  const events: LandedEvent[] = []
  const starts = new Map<string, ActiveSessionInfo[]>()
  for (const session of sessions) {
    if (session.archived) continue
    for (const pullRequest of session.pullRequests ?? []) {
      const at = Date.parse(pullRequest.timestamp)
      if (at >= since) events.push({ kind: "pr", at, session, number: pullRequest.number, title: pullRequest.title, url: pullRequest.url })
    }
    if (!session.crew) continue
    const activity = getSessionRecencyMs(session)
    if (activity >= since && statusOf(session).state === "done") events.push({ kind: "finished", at: activity, session })
    if (session.crew.startedAt >= since) {
      const key = `${session.crew.parentId}:${Math.floor(session.crew.startedAt / 60_000)}`
      const group = starts.get(key)
      if (group) group.push(session)
      else starts.set(key, [session])
    }
  }
  for (const group of starts.values()) {
    events.push({ kind: "started", at: Math.min(...group.map((session) => session.crew!.startedAt)), parentId: group[0]!.crew!.parentId, sessions: group })
  }
  return events.sort((a, b) => b.at - a.at).slice(0, MAX_LANDED)
}
