import { sortSessionsByRecency } from "@/lib/sessionOrdering"
import { isSessionActive } from "@/lib/sessionActivity"
import type { ActiveSessionInfo, RunningProcess } from "./types"

/**
 * Why a session is asking for the user's attention.
 *
 * `permission` and `deferred` are deliberately distinct even though both are
 * about permissions: a live request is answered in place, while a hook-deferred
 * one is cleared by resuming the session. Offering "Resume" for a live request
 * would spawn a second CLI against a session that is alive and merely waiting.
 */
export type AttentionReason = "permission" | "deferred" | "question" | "waiting" | "done"

export interface AttentionItem {
  session: ActiveSessionInfo
  reason: AttentionReason
}

export interface AttentionGroups {
  /** Sessions blocked on the user: deferred permissions, agents idle at the prompt, fresh completions. */
  needsYou: AttentionItem[]
  /** Sessions actively running (thinking / tool use / processing). */
  working: ActiveSessionInfo[]
}

function isTeammate(s: ActiveSessionInfo): boolean {
  return !!(s.teamName && s.agentName)
}

const WORKING_STATUSES = new Set(["thinking", "tool_use", "processing", "compacting"])

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
 * They stay separate reasons because the remedies differ: a deferred permission
 * is cleared by resuming the session, a question by answering it.
 */
export function classifyAttention(
  sessions: ActiveSessionInfo[],
  procBySession: Map<string, RunningProcess>,
  newlyCompleted: Set<string>,
  sessionsAwaitingPermission?: ReadonlySet<string>,
  sessionsAwaitingQuestion?: ReadonlySet<string>,
): AttentionGroups {
  const needsYou: AttentionItem[] = []
  const working: ActiveSessionInfo[] = []

  for (const s of sortSessionsByRecency(sessions)) {
    if (sessionsAwaitingPermission?.has(s.sessionId)) {
      needsYou.push({ session: s, reason: "permission" })
      continue
    }
    if (sessionsAwaitingQuestion?.has(s.sessionId)) {
      needsYou.push({ session: s, reason: "question" })
      continue
    }
    if (s.agentStatus === "deferred") {
      needsYou.push({ session: s, reason: "deferred" })
      continue
    }
    if (isTeammate(s)) continue

    // Owned-by-this-Cogpit is too narrow: sessions started elsewhere never map
    // to a PID, and would all be triaged as finished. See lib/sessionActivity.
    const live = isSessionActive(s, procBySession)
    if (s.agentStatus === "completed" || !live) {
      if (newlyCompleted.has(s.sessionId)) needsYou.push({ session: s, reason: "done" })
      continue
    }
    if (s.agentStatus === "idle") {
      needsYou.push({ session: s, reason: "waiting" })
      continue
    }
    if (!s.agentStatus || WORKING_STATUSES.has(s.agentStatus)) {
      working.push(s)
    }
  }

  return { needsYou, working }
}

/** Short chip label for a working session — the current tool, or the phase. */
export function workingChip(s: ActiveSessionInfo): string {
  switch (s.agentStatus) {
    case "tool_use": return s.agentToolName || "Tool"
    case "thinking": return "Thinking"
    case "processing": return "Processing"
    case "compacting": return "Compacting"
    default: return "Running"
  }
}
