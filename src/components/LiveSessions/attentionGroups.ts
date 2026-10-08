import { getSessionRecencyMs, sortSessionsByRecency } from "../../../shared/session-ordering"
import { isSessionActive, WORKING_STATUSES } from "@/lib/sessionActivity"
import { countCrew, type CrewCounts, type MemberStatus } from "./crew"
import type { ActiveSessionInfo, RunningProcess } from "./types"

/**
 * Why a session is asking for the user's attention.
 *
 * `permission` and `deferred` are deliberately distinct even though both are
 * about permissions: a live request is answered in place, while a hook-deferred
 * one is cleared by resuming the session. Offering "Resume" for a live request
 * would spawn a second CLI against a session that is alive and merely waiting.
 */
export type AttentionReason =
  | "permission"
  | "deferred"
  | "question"
  | "prompt"
  | "plan"
  | "waiting"
  | "done"
  /** Not the session itself: members of its crew are blocked. */
  | "crew"

export interface AttentionItem {
  session: ActiveSessionInfo
  reason: AttentionReason
  /** For a crew's root, its members by what they are doing. */
  crew?: CrewCounts
}

export interface AttentionGroups {
  /** Sessions blocked on the user: deferred permissions, agents idle at the prompt, fresh completions. */
  needsYou: AttentionItem[]
  /** Sessions actively running (thinking / tool use / processing). */
  working: ActiveSessionInfo[]
  /** Roots listed as working only because members of their crew are. */
  workingCrews?: ReadonlyMap<string, CrewCounts>
}

function isTeammate(s: ActiveSessionInfo): boolean {
  return !!(s.teamName && s.agentName)
}

/**
 * Triage sessions into "needs you" and "working" buckets, newest-first.
 *
 * Teammate sessions are excluded (their lead represents the team) except for
 * deferred permissions, which always need the user regardless of who hit them.
 * A live session with an unknown status is assumed to be working — never claim
 * a session needs the user without a positive signal.
 *
 * `sessionsAwaitingPermission` and `sessionsAwaitingQuestion` carry session ids
 * blocked on a live permission request or an AskUserQuestion call. Neither is
 * visible in `agentStatus` — a session blocked on a question still reports
 * `tool_use` — and a blocked agent is stopped dead, so both outrank every other
 * signal.
 *
 * `sessionsAwaitingPrompt` carries the same blind spot one level further out:
 * an MCP elicitation or a CLI dialog parks the CLI on a callback that never
 * reaches the transcript at all.
 * `sessionsAwaitingPlan` marks Copilot plans that are reviewed by opening the
 * session.
 *
 * They stay separate reasons because the remedies differ: a deferred permission
 * is cleared by resuming the session, a question by answering it.
 *
 * Only a session the user can act on (`canAct`: interact or own) needs them; a
 * teammate's session they can only view is left out, though its running work
 * still shows.
 */
export function classifyAttention(
  sessions: ActiveSessionInfo[],
  procBySession: Map<string, RunningProcess>,
  newlyCompleted: Set<string>,
  sessionsAwaitingPermission?: ReadonlySet<string>,
  sessionsAwaitingQuestion?: ReadonlySet<string>,
  sessionsAwaitingPrompt?: ReadonlySet<string>,
  sessionsAwaitingPlan?: ReadonlySet<string>,
  canAct: (session: ActiveSessionInfo) => boolean = () => true,
): AttentionGroups {
  const needsYou: AttentionItem[] = []
  const working: ActiveSessionInfo[] = []

  for (const s of sortSessionsByRecency(sessions)) {
    const needs = (reason: AttentionReason) => {
      if (canAct(s)) needsYou.push({ session: s, reason })
    }
    if (sessionsAwaitingPermission?.has(s.sessionId)) {
      needs("permission")
      continue
    }
    if (sessionsAwaitingQuestion?.has(s.sessionId)) {
      needs("question")
      continue
    }
    if (sessionsAwaitingPrompt?.has(s.sessionId)) {
      needs("prompt")
      continue
    }
    if (sessionsAwaitingPlan?.has(s.sessionId)) {
      needs("plan")
      continue
    }
    if (s.agentStatus === "deferred") {
      needs("deferred")
      continue
    }
    if (isTeammate(s)) continue

    // Owned-by-this-Cogpit is too narrow: sessions started elsewhere never map
    // to a PID, and would all be triaged as finished. See lib/sessionActivity.
    const live = isSessionActive(s, procBySession)
    if (s.agentStatus === "completed" || !live) {
      if (newlyCompleted.has(s.sessionId)) needs("done")
      continue
    }
    if (s.agentStatus === "idle") {
      needs("waiting")
      continue
    }
    if (!s.agentStatus || WORKING_STATUSES.has(s.agentStatus)) {
      working.push(s)
    }
  }

  return { needsYou, working }
}

/**
 * Fold each crew into its root, so the strip lists the sessions the user
 * started and never the ones those sessions started. A root whose members are
 * blocked needs the user even when it is not; one whose members work is
 * working. `groups` must come from the roots alone.
 */
export function rollUpCrews(
  groups: AttentionGroups,
  roots: readonly ActiveSessionInfo[],
  crewOf: ReadonlyMap<string, readonly ActiveSessionInfo[]>,
  statusOf: (member: ActiveSessionInfo) => MemberStatus,
  canAct: (session: ActiveSessionInfo) => boolean = () => true,
): AttentionGroups {
  const needsYou = [...groups.needsYou]
  const working = [...groups.working]
  const workingCrews = new Map<string, CrewCounts>()
  for (const root of roots) {
    const members = crewOf.get(root.sessionId)
    if (!members?.length) continue
    const counts = countCrew(members, (member) => {
      const status = statusOf(member)
      return status.state === "needs-you" && !canAct(member) ? { state: "done" } : status
    })
    const listed = needsYou.findIndex((item) => item.session.sessionId === root.sessionId)
    if (counts.needsYou > 0) {
      if (listed >= 0) {
        needsYou[listed] = { ...needsYou[listed]!, crew: counts }
      } else {
        needsYou.push({ session: root, reason: "crew", crew: counts })
        const wasWorking = working.indexOf(root)
        if (wasWorking >= 0) working.splice(wasWorking, 1)
      }
    } else if (counts.working > 0 && listed < 0 && !working.includes(root)) {
      working.push(root)
      workingCrews.set(root.sessionId, counts)
    }
  }
  const waitedSince = (item: AttentionItem) => (item.reason === "crew" && item.crew?.longestWaitSince
    ? Date.parse(item.crew.longestWaitSince)
    : getSessionRecencyMs(item.session))
  needsYou.sort((a, b) => waitedSince(b) - waitedSince(a))
  return { needsYou, working: sortSessionsByRecency(working), workingCrews }
}

/** Short chip label for a working session — the current tool, or the phase. */
export function workingChip(s: ActiveSessionInfo): string {
  switch (s.agentStatus) {
    case "tool_use": return s.agentToolName || "Tool"
    case "thinking": return "Thinking"
    case "processing": return "Processing"
    case "compacting": return "Compacting"
    case "awaiting_agents": return "Agents running"
    default: return "Running"
  }
}
