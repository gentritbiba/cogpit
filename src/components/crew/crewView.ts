/**
 * What the Crew panel shows, worked out from `/api/session-crew`: the tree,
 * the formation strip's cells, the queue of requests, the tally, and the
 * names, which follow the session list so a member is called the same
 * everywhere.
 */

import type { CrewMember, SessionCrew } from "../../../shared/contracts/crew"
import type { PendingInput } from "../../../shared/contracts/pendingInput"
import { memberName } from "@/components/LiveSessions/crew"
import { sessionTitle } from "@/components/LiveSessions/sessionListView"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"

export type CrewCellState = "working" | "needs-you" | "done" | "failed" | "unreachable"

export function memberCellState(member: CrewMember): CrewCellState {
  switch (member.outcome) {
    case "needs_input": return "needs-you"
    case "running": return "working"
    case "error": return "failed"
    case "unreachable":
    case "not_found": return "unreachable"
    default: return "done"
  }
}

/** The member as a session-list row, so naming rules are shared. */
function asListedRow(member: CrewMember, rootId: string): ActiveSessionInfo {
  return {
    sessionId: member.sessionId,
    dirName: member.address?.dirName ?? "",
    fileName: member.address?.fileName ?? "",
    projectShortName: "",
    lastModified: member.lastActivityAt ?? "",
    lastActivityAt: member.lastActivityAt,
    size: 0,
    cwd: member.cwd,
    customTitle: member.customTitle,
    aiTitle: member.aiTitle,
    firstUserMessage: member.firstUserMessage,
    ...(member.parentId && {
      crew: { rootId, parentId: member.parentId, startedAt: member.startedAt ?? 0, ...(member.name && { name: member.name }) },
    }),
  }
}

export function crewMemberName(
  member: CrewMember,
  byId: ReadonlyMap<string, CrewMember>,
  sessionNames: Record<string, string>,
): string {
  const rootId = [...byId.values()].find((value) => value.parentId === null)?.sessionId ?? member.sessionId
  const customName = sessionNames[member.sessionId]
  const row = asListedRow(member, rootId)
  if (!member.parentId) return sessionTitle(row, customName)
  const parent = byId.get(member.parentId)
  return memberName(row, { customName, parent: parent && asListedRow(parent, rootId) })
}

export interface CrewTreeRow {
  member: CrewMember
  depth: number
  /** Members it started itself. */
  children: number
}

/** The members under the root, depth first, each level in the order they were started. */
export function crewTree(crew: SessionCrew): CrewTreeRow[] {
  const childrenOf = new Map<string, CrewMember[]>()
  for (const value of crew.members) {
    if (!value.parentId) continue
    const siblings = childrenOf.get(value.parentId)
    if (siblings) siblings.push(value)
    else childrenOf.set(value.parentId, [value])
  }
  const rows: CrewTreeRow[] = []
  const seen = new Set<string>()
  const visit = (parentId: string, depth: number) => {
    const children = [...(childrenOf.get(parentId) ?? [])].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    for (const child of children) {
      if (seen.has(child.sessionId)) continue
      seen.add(child.sessionId)
      rows.push({ member: child, depth, children: childrenOf.get(child.sessionId)?.length ?? 0 })
      visit(child.sessionId, depth + 1)
    }
  }
  visit(crew.rootId, 0)
  // Members whose parent the caller cannot see still belong to the crew.
  for (const value of crew.members) {
    if (value.parentId && !seen.has(value.sessionId)) {
      seen.add(value.sessionId)
      rows.push({ member: value, depth: 0, children: 0 })
    }
  }
  return rows
}

export interface CrewRequest {
  member: CrewMember
  pending: PendingInput
}

/** Every request the crew, root included, is blocked on, the longest waiting first. */
export function crewRequests(crew: SessionCrew): CrewRequest[] {
  const waitedSince = ({ member, pending }: CrewRequest) => pending.askedAt ?? (Date.parse(member.lastActivityAt ?? "") || 0)
  return crew.members.flatMap((member) => member.waiting.map((pending) => ({ member, pending })))
    .sort((a, b) => waitedSince(a) - waitedSince(b))
}

export interface CrewTally {
  size: number
  working: number
  needsYou: number
  done: number
  failed: number
  unreachable: number
  /** Finished members whose result the session that started them has not read. */
  unreadResults: number
}

/** The members under the root, counted by what they are doing. */
export function crewTally(crew: SessionCrew): CrewTally {
  const tally: CrewTally = { size: 0, working: 0, needsYou: 0, done: 0, failed: 0, unreachable: 0, unreadResults: 0 }
  for (const value of crew.members) {
    if (!value.parentId) continue
    tally.size++
    const state = memberCellState(value)
    if (state === "working") tally.working++
    else if (state === "needs-you") tally.needsYou++
    else if (state === "failed") tally.failed++
    else if (state === "unreachable") tally.unreachable++
    else tally.done++
    if (hasUnreadResult(value)) tally.unreadResults++
  }
  return tally
}

export function hasUnreadResult(member: CrewMember): boolean {
  return Boolean(member.result && member.result.state !== "running" && !member.result.acknowledged)
}

/** What a member is doing, in one line. */
export function memberActivity(member: CrewMember): string {
  const [first] = member.waiting
  switch (memberCellState(member)) {
    case "needs-you":
      if (first?.kind === "permission") return `Waiting on a permission · ${first.toolName}`
      if (first?.kind === "question") return "Asked a question"
      return "Plan to review"
    case "working":
      if (member.status === "tool_use" && member.toolName) return member.toolName
      if (member.status === "thinking") return "Thinking"
      if (member.status === "compacting") return "Compacting"
      if (member.status === "awaiting_agents") return "Waiting on its agents"
      return "Working"
    case "failed":
      return member.error ? `Failed · ${member.error}` : "Failed"
    case "unreachable":
      return member.device ? `${member.device.name} is not answering` : "Not found"
    default:
      return hasUnreadResult(member) ? "Finished · result unread" : "Finished"
  }
}
