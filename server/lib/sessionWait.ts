import { getSessionStatus } from "../helpers"
import { listPendingInput, type PendingInput } from "../agents/pendingInput"
import { storeForPath } from "../agents"
import { runtimeFor, runtimeForSession } from "../agents/runtimes"
import { findJsonlPath } from "../sessionPaths"
import type { SessionStatusInfo } from "../../shared/session/types"

/**
 * One answer to "is that session done?" for agents driving other sessions.
 *
 * `outcome` folds the three signals a caller would otherwise combine by hand:
 * the runtime's `running` flag (exact for sessions this server manages), the
 * transcript tail status (the only signal for sessions started elsewhere), and
 * the requests a session is blocked on — which leave `running` true forever,
 * so a poll loop on `running` alone hangs on the first permission prompt.
 */

export type SessionOutcome = "running" | "needs_input" | "completed" | "error" | "not_found"

export interface SessionState extends Partial<SessionStatusInfo> {
  sessionId: string
  outcome: SessionOutcome
  live: boolean
  running: boolean
  waiting: PendingInput[]
  error?: string
}

const IN_FLIGHT_STATUSES = new Set(["thinking", "tool_use", "processing", "compacting", "awaiting_agents"])

/**
 * Turn errors from sends that nobody waited on: a resume reports its failure
 * only on the request that started it, and the session CLI returns before then.
 */
const turnErrors = new Map<string, string>()

export function recordTurnError(sessionId: string, message: string): void {
  turnErrors.set(sessionId, message)
}

export function clearTurnError(sessionId: string): void {
  turnErrors.delete(sessionId)
}

export async function readSessionState(sessionId: string): Promise<SessionState> {
  // The transcript decides whose session it is; a live session whose
  // transcript is not on disk yet falls back to the runtime holding it.
  const filePath = await findJsonlPath(sessionId)
  const kind = storeForPath(filePath)?.kind
  const runtime = kind ? runtimeFor(kind) : runtimeForSession(sessionId)
  if (!runtime) {
    return { sessionId, outcome: "not_found", live: false, running: false, waiting: [] }
  }

  const activity = runtime.activity(sessionId)
  const statusInfo = filePath ? await getSessionStatus(filePath) : undefined
  const waiting = listPendingInput(sessionId)
  const error = turnErrors.get(sessionId) ?? statusInfo?.terminalReason

  let outcome: SessionOutcome
  if (waiting.length > 0) outcome = "needs_input"
  else if (activity.running) outcome = "running"
  // A managed session between turns is idle whatever the tail says; the tail
  // lags the turn boundary by a flush. Background agents still resume it.
  else if (statusInfo?.status === "awaiting_agents") outcome = "running"
  else if (!activity.live && statusInfo && IN_FLIGHT_STATUSES.has(statusInfo.status)) outcome = "running"
  else if (error) outcome = "error"
  else outcome = "completed"

  return {
    sessionId,
    outcome,
    ...activity,
    ...statusInfo,
    waiting,
    ...(error && outcome === "error" ? { error } : {}),
  }
}

/** Under the two-minute default of agents' shell tools, so a bare `wait` is never killed. */
export const DEFAULT_WAIT_SECONDS = 90
const MAX_WAIT_SECONDS = 3600

/** Seconds from a query or body value; null when it is not a usable duration. */
export function parseWaitSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_WAIT_SECONDS
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds, MAX_WAIT_SECONDS)
}

export interface WaitOptions {
  /** `any` returns once one session settles, `all` once every one has. */
  mode: "any" | "all"
  timeoutMs: number
  signal?: AbortSignal
  pollMs?: number
}

export interface WaitResult {
  timedOut: boolean
  sessions: SessionState[]
}

const settled = (state: SessionState) => state.outcome !== "running"

export async function waitForSessions(
  sessionIds: readonly string[],
  { mode, timeoutMs, signal, pollMs = 750 }: WaitOptions,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const sessions = await Promise.all(sessionIds.map(readSessionState))
    const done = mode === "all" ? sessions.every(settled) : sessions.some(settled)
    if (done) return { timedOut: false, sessions }
    if (signal?.aborted || Date.now() >= deadline) return { timedOut: true, sessions }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
  }
}
