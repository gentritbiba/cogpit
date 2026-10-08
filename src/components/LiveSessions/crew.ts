/**
 * Crews in the session list: the sessions one session started through Cogpit,
 * and theirs. The server folds a crew under its root before it pages the list
 * and sends every member after the listed sessions; this places the rows the
 * client holds the same way, and says what each member is doing.
 */

import { getSessionRecencyMs } from "../../../shared/session-ordering"
import { isSessionActive, WORKING_STATUSES } from "@/lib/sessionActivity"
import { sessionTitle } from "./sessionListView"
import type { ActiveSessionInfo, RunningProcess } from "./types"

/** The requests a session can be blocked on, by session id. */
export interface CrewPendingInput {
  awaitingPermission: ReadonlySet<string>
  awaitingQuestion: ReadonlySet<string>
  awaitingPrompt: ReadonlySet<string>
  awaitingPlan: ReadonlySet<string>
}

export const NO_PENDING_INPUT: CrewPendingInput = {
  awaitingPermission: new Set(),
  awaitingQuestion: new Set(),
  awaitingPrompt: new Set(),
  awaitingPlan: new Set(),
}

export type MemberState = "needs-you" | "working" | "done"
export type MemberNeed = "permission" | "question" | "input" | "plan" | "deferred"

export interface MemberStatus {
  state: MemberState
  need?: MemberNeed
}

export interface CrewFolding {
  /** Rows placed on their own, in the order given. */
  topLevel: ActiveSessionInfo[]
  /** The members riding with each row that carries a crew, in the order they were started. */
  crewOf: ReadonlyMap<string, ActiveSessionInfo[]>
}

/**
 * Place each member under the highest listed ancestor that may carry it, as
 * the server does: archived sessions carry no crew, and a member with no
 * listed ancestor stays on its own.
 */
export function foldCrewRows(rows: readonly ActiveSessionInfo[]): CrewFolding {
  const byId = new Map(rows.map((value) => [value.sessionId, value]))
  const canHost = (sessionId: string) => {
    const host = byId.get(sessionId)
    return host !== undefined && !host.archived
  }
  const topLevel: ActiveSessionInfo[] = []
  const crewOf = new Map<string, ActiveSessionInfo[]>()

  for (const value of rows) {
    const crew = value.crew
    if (!crew) {
      topLevel.push(value)
      continue
    }
    const chain: string[] = []
    let current: string | undefined = crew.parentId
    while (current && current !== value.sessionId && byId.has(current) && !chain.includes(current)) {
      chain.push(current)
      current = byId.get(current)?.crew?.parentId
    }
    if (crew.rootId !== value.sessionId && !chain.includes(crew.rootId)) chain.push(crew.rootId)
    const host = [...chain].reverse().find(canHost)
    if (!host) {
      topLevel.push(value)
      continue
    }
    const members = crewOf.get(host)
    if (members) members.push(value)
    else crewOf.set(host, [value])
  }

  for (const members of crewOf.values()) {
    members.sort((a, b) => (a.crew?.startedAt ?? 0) - (b.crew?.startedAt ?? 0))
  }
  return { topLevel, crewOf }
}

/**
 * What a member is doing. A member that ended its turn is done: it waits for
 * the session that started it, not for the user.
 */
export function memberStatus(
  value: ActiveSessionInfo,
  procBySession: Map<string, RunningProcess>,
  pending: CrewPendingInput,
): MemberStatus {
  const id = value.sessionId
  if (pending.awaitingPermission.has(id)) return { state: "needs-you", need: "permission" }
  if (pending.awaitingQuestion.has(id)) return { state: "needs-you", need: "question" }
  if (pending.awaitingPrompt.has(id)) return { state: "needs-you", need: "input" }
  if (pending.awaitingPlan.has(id)) return { state: "needs-you", need: "plan" }
  if (value.agentStatus === "deferred") return { state: "needs-you", need: "deferred" }
  const working = isSessionActive(value, procBySession)
    && (!value.agentStatus || WORKING_STATUSES.has(value.agentStatus))
  return { state: working ? "working" : "done" }
}

export interface CrewCounts {
  size: number
  needsYou: number
  working: number
  done: number
  /** When the member waiting longest last did anything; undefined when none waits. */
  longestWaitSince?: string
}

export function countCrew(
  members: readonly ActiveSessionInfo[],
  statusOf: (member: ActiveSessionInfo) => MemberStatus,
): CrewCounts {
  const counts: CrewCounts = { size: members.length, needsYou: 0, working: 0, done: 0 }
  let longest: ActiveSessionInfo | undefined
  for (const value of members) {
    const { state } = statusOf(value)
    if (state === "needs-you") {
      counts.needsYou++
      if (!longest || getSessionRecencyMs(value) < getSessionRecencyMs(longest)) longest = value
    } else if (state === "working") {
      counts.working++
    } else {
      counts.done++
    }
  }
  if (longest) counts.longestWaitSince = longest.lastActivityAt || longest.lastModified
  return counts
}

/** When the session or any member last did something. */
export function crewActivityAt(host: ActiveSessionInfo, members: readonly ActiveSessionInfo[]): string {
  const latest = members.reduce(
    (best, value) => (getSessionRecencyMs(value) > getSessionRecencyMs(best) ? value : best),
    host,
  )
  return latest.lastActivityAt || latest.lastModified
}

function folderOf(value: ActiveSessionInfo | undefined): string | undefined {
  return value?.cwd?.replace(/\/+$/, "").split("/").at(-1) || undefined
}

/**
 * What to call a member in its crew: the user's name, the name it was started
 * with, its own title, the folder it works in when that tells it from the
 * session above it, and only then its prompt.
 */
export function memberName(
  value: ActiveSessionInfo,
  { customName, parent }: { customName?: string; parent?: ActiveSessionInfo },
): string {
  if (customName) return customName
  if (value.crew?.name) return value.crew.name
  if (value.customTitle) return value.customTitle
  const folder = folderOf(value)
  if (folder && folder !== folderOf(parent)) return folder
  return briefTitle(value.firstUserMessage) ?? sessionTitle(value)
}

const BRIEF_TITLE_LENGTH = 60

/**
 * The first line of the brief a member was started with, without markdown
 * heading marks: "# Reviewer instructions" reads as "Reviewer instructions".
 */
function briefTitle(brief: string | undefined): string | undefined {
  const line = brief?.split("\n").map((part) => part.replace(/^#+\s*/, "").trim()).find(Boolean)
  if (!line) return undefined
  return line.length > BRIEF_TITLE_LENGTH ? `${line.slice(0, BRIEF_TITLE_LENGTH - 1)}…` : line
}

/** How many members a member started itself. */
export function directReports(sessionId: string, members: readonly ActiveSessionInfo[]): number {
  return members.filter((value) => value.crew?.parentId === sessionId).length
}

/**
 * What a listed session is called where another names it, such as in a
 * member's lineage; undefined when the list does not carry it.
 */
export function crewSessionTitle(
  sessionId: string,
  knownById: ReadonlyMap<string, ActiveSessionInfo>,
  sessionNames: Record<string, string>,
): string | undefined {
  const known = knownById.get(sessionId)
  if (!known) return undefined
  const customName = sessionNames[sessionId]
  if (!known.crew) return sessionTitle(known, customName)
  return memberName(known, { customName, parent: knownById.get(known.crew.parentId) })
}
