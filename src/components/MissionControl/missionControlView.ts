/**
 * Pure view logic for the Mission Control grid — how a session is stated,
 * ordered, filtered and formatted. Kept free of React so it can be tested
 * directly.
 */

import { sortSessionsByRecency } from "@/lib/sessionOrdering"
import { WORKING_STATUSES, isSessionActive } from "@/lib/sessionActivity"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import type {
  MissionControlPermission,
  MissionControlSummary,
} from "../../../shared/contracts/missionControl"

/**
 * What a card says about a session.
 *
 * `awaiting_approval` is a live permission request answerable inline;
 * `awaiting_answer` is a session idle at the prompt or paused by a deferred
 * hook — it needs the user, but only opening the session resolves it.
 */
export type MissionCardState =
  | "awaiting_approval"
  | "awaiting_answer"
  | "running"
  | "done"
  | "failed"

export type MissionFilter = "all" | "running" | "needs-you" | "finished"

export interface MissionCard {
  session: ActiveSessionInfo
  state: MissionCardState
  summary: MissionControlSummary | null
  /** Pending requests for this session; non-empty only for awaiting_approval. */
  permissions: MissionControlPermission[]
}

/** True when the card is blocked on the user. */
export function needsYou(state: MissionCardState): boolean {
  return state === "awaiting_approval" || state === "awaiting_answer"
}

/** True when the session has stopped, successfully or not. */
export function isFinished(state: MissionCardState): boolean {
  return state === "done" || state === "failed"
}

/**
 * Ordering weight — blocked sessions first, then work in flight, then results.
 *
 * Within "blocked", an answerable permission outranks an idle prompt because it
 * is the one the user can clear from the grid itself.
 */
const STATE_RANK: Record<MissionCardState, number> = {
  awaiting_approval: 0,
  awaiting_answer: 1,
  running: 2,
  failed: 3,
  done: 4,
}

function resolveState(
  session: ActiveSessionInfo,
  active: boolean,
  hasPermission: boolean,
): MissionCardState {
  if (hasPermission) return "awaiting_approval"
  // A deferred hook needs the user but cannot be answered from the grid.
  if (session.agentStatus === "deferred") return "awaiting_answer"
  if (session.agentStatus === "idle" && active) return "awaiting_answer"
  // terminalReason is only ever set alongside "completed", and any value means
  // the run stopped early rather than finishing.
  if (session.agentTerminalReason) return "failed"
  if (session.agentStatus === "completed") return "done"
  if (active && session.agentStatus && WORKING_STATUSES.has(session.agentStatus)) {
    return "running"
  }
  return "done"
}

export interface BuildCardsOptions {
  sessions: ActiveSessionInfo[]
  procBySession: Map<string, RunningProcess>
  summaries: Map<string, MissionControlSummary>
  permissionsBySession: Map<string, MissionControlPermission[]>
  /** Sessions that finished during this browser session, kept visible. */
  newlyCompleted: ReadonlySet<string>
  /** Finished sessions to keep after the recently-finished ones. */
  finishedLimit?: number
  /** Injected for tests; defaults to now. */
  now?: number
}

const DEFAULT_FINISHED_LIMIT = 6

/**
 * Build the ordered card list.
 *
 * Everything live or blocked is included. Finished sessions are capped so the
 * grid stays a picture of current work rather than a session archive; the ones
 * that finished while the user was watching are always kept.
 */
export function buildMissionCards({
  sessions,
  procBySession,
  summaries,
  permissionsBySession,
  newlyCompleted,
  finishedLimit = DEFAULT_FINISHED_LIMIT,
  now = Date.now(),
}: BuildCardsOptions): MissionCard[] {
  const cards: MissionCard[] = []

  for (const session of sortSessionsByRecency(sessions)) {
    // A teammate's own session is represented by its lead, unless it is the one
    // actually blocked on the user.
    const isTeammate = Boolean(session.teamName && session.agentName)
    const permissions = permissionsBySession.get(session.sessionId) ?? []
    if (isTeammate && permissions.length === 0) continue

    const active = isSessionActive(session, procBySession, now)
    cards.push({
      session,
      state: resolveState(session, active, permissions.length > 0),
      summary: summaries.get(session.sessionId) ?? null,
      permissions,
    })
  }

  const activeCards = cards.filter((c) => !isFinished(c.state))
  const finished = cards.filter((c) => isFinished(c.state))
  const keptFinished = [
    ...finished.filter((c) => newlyCompleted.has(c.session.sessionId)),
    ...finished.filter((c) => !newlyCompleted.has(c.session.sessionId)),
  ].slice(0, finishedLimit)

  return [...activeCards, ...keptFinished].sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state]
    if (rank !== 0) return rank
    return 0 // sortSessionsByRecency already ordered within each state
  })
}

export function filterMissionCards(
  cards: MissionCard[],
  filter: MissionFilter,
): MissionCard[] {
  switch (filter) {
    case "running":
      return cards.filter((c) => c.state === "running")
    case "needs-you":
      return cards.filter((c) => needsYou(c.state))
    case "finished":
      return cards.filter((c) => isFinished(c.state))
    default:
      return cards
  }
}

export interface MissionCounts {
  total: number
  running: number
  needsYou: number
  finished: number
  failed: number
}

export function countMissionCards(cards: MissionCard[]): MissionCounts {
  const counts: MissionCounts = { total: cards.length, running: 0, needsYou: 0, finished: 0, failed: 0 }
  for (const card of cards) {
    if (card.state === "running") counts.running++
    if (needsYou(card.state)) counts.needsYou++
    if (isFinished(card.state)) counts.finished++
    if (card.state === "failed") counts.failed++
  }
  return counts
}

/** "3m 12s" / "1h 04m" — compact elapsed time for the card metric row. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

/** "148,092" — thousands-separated token counts. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  return value.toLocaleString("en-US")
}

/**
 * Context bar colour, matching the badge thresholds used elsewhere: green until
 * 70% consumed, amber past that, red once nearly full.
 */
export function contextBarColor(percent: number): string {
  if (percent >= 90) return "bg-red-500"
  if (percent >= 70) return "bg-amber-500"
  return "bg-green-500"
}
