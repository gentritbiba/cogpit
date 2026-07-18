import { sortSessionsByRecency } from "@/lib/sessionOrdering"
import type { ActiveSessionInfo, RunningProcess } from "./SessionRow"

/** Why a session is asking for the user's attention. */
export type AttentionReason = "permission" | "waiting" | "done"

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
 */
export function classifyAttention(
  sessions: ActiveSessionInfo[],
  procBySession: Map<string, RunningProcess>,
  newlyCompleted: Set<string>,
): AttentionGroups {
  const needsYou: AttentionItem[] = []
  const working: ActiveSessionInfo[] = []

  for (const s of sortSessionsByRecency(sessions)) {
    if (s.agentStatus === "deferred") {
      needsYou.push({ session: s, reason: "permission" })
      continue
    }
    if (isTeammate(s)) continue

    const live = s.isActive === true || procBySession.has(s.sessionId)
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
