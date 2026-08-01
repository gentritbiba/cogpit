/**
 * Pure view logic for the Mission Control grid — how a session is stated,
 * ordered and filtered. Kept free of React so it can be tested directly.
 */

import { sortSessionsByRecency } from "@/lib/sessionOrdering"
import { WORKING_STATUSES, isSessionActive } from "@/lib/sessionActivity"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import type {
  MissionControlPermission,
  MissionControlQuestion,
  MissionControlSummary,
} from "../../../shared/contracts/missionControl"

/**
 * `awaiting_approval` (a live permission request) and `awaiting_question` (a
 * blocked AskUserQuestion) are answerable from the grid itself;
 * `awaiting_answer` — idle at the prompt, or paused by a deferred hook — is
 * only resolved by opening the session.
 */
export type MissionCardState =
  | "awaiting_approval"
  | "awaiting_question"
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
  /** Blocked AskUserQuestion calls; non-empty only for awaiting_question. */
  questions: MissionControlQuestion[]
}

/** True when the card is blocked on the user. */
export function needsYou(state: MissionCardState): boolean {
  return state === "awaiting_approval"
    || state === "awaiting_question"
    || state === "awaiting_answer"
}

/** True when the session has stopped, successfully or not. */
export function isFinished(state: MissionCardState): boolean {
  return state === "done" || state === "failed"
}

/**
 * Blocked sessions first, then work in flight, then results. Within "blocked",
 * what the user can clear from the grid outranks what needs a session opened.
 */
const STATE_RANK: Record<MissionCardState, number> = {
  awaiting_approval: 0,
  awaiting_question: 1,
  awaiting_answer: 2,
  running: 3,
  failed: 4,
  done: 5,
}

function resolveState(
  session: ActiveSessionInfo,
  active: boolean,
  hasPermission: boolean,
  hasQuestion: boolean,
): MissionCardState {
  if (hasPermission) return "awaiting_approval"
  // Must precede every agentStatus branch. A question-blocked session still
  // reports `tool_use`, and a blocked agent stops writing to its JSONL, so
  // ordering it later would render it "Running" until the file went stale and
  // then "Done" — a session waiting on the user would vanish into the finished
  // bucket.
  if (hasQuestion) return "awaiting_question"
  // A deferred hook needs the user but cannot be answered from the grid.
  if (session.agentStatus === "deferred") return "awaiting_answer"
  if (session.agentStatus === "idle" && active) return "awaiting_answer"
  // terminalReason is only ever set alongside "completed", and any value means
  // the run stopped early rather than finishing.
  if (session.agentTerminalReason) return "failed"
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
  questionsBySession: Map<string, MissionControlQuestion[]>
  /** Sessions that finished during this browser session, kept visible. */
  newlyCompleted: ReadonlySet<string>
  /** Finished sessions to keep after the recently-finished ones. */
  finishedLimit?: number
  /** Injected for tests; defaults to now. */
  now?: number
}

const DEFAULT_FINISHED_LIMIT = 6

/** Build the ordered card list: everything live or blocked, plus recent results. */
export function buildMissionCards({
  sessions,
  procBySession,
  summaries,
  permissionsBySession,
  questionsBySession,
  newlyCompleted,
  finishedLimit = DEFAULT_FINISHED_LIMIT,
  now = Date.now(),
}: BuildCardsOptions): MissionCard[] {
  const cards: MissionCard[] = []

  for (const session of sortSessionsByRecency(sessions)) {
    const permissions = permissionsBySession.get(session.sessionId) ?? []
    const questions = questionsBySession.get(session.sessionId) ?? []
    // A teammate's own session is represented by its lead, unless it is the one
    // actually blocked on the user.
    const isTeammate = Boolean(session.teamName && session.agentName)
    if (isTeammate && permissions.length === 0 && questions.length === 0) continue

    cards.push({
      session,
      state: resolveState(
        session,
        isSessionActive(session, procBySession, now),
        permissions.length > 0,
        questions.length > 0,
      ),
      summary: summaries.get(session.sessionId) ?? null,
      permissions,
      questions,
    })
  }

  // Finished sessions are capped so the grid stays a picture of current work
  // rather than a session archive; the ones that finished while the user was
  // watching are always kept.
  const finished = cards.filter((c) => isFinished(c.state))
  const keptFinished = [
    ...finished.filter((c) => newlyCompleted.has(c.session.sessionId)),
    ...finished.filter((c) => !newlyCompleted.has(c.session.sessionId)),
  ].slice(0, finishedLimit)

  // Stable sort: sortSessionsByRecency already ordered within each state.
  return [...cards.filter((c) => !isFinished(c.state)), ...keptFinished]
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])
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

/**
 * Context bar colour, matching the badge thresholds used elsewhere: green until
 * 70% consumed, amber past that, red once nearly full.
 */
export function contextBarColor(percent: number): string {
  if (percent >= 90) return "bg-red-500"
  if (percent >= 70) return "bg-amber-500"
  return "bg-green-500"
}
