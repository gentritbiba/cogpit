import { stat } from "node:fs/promises"
import { getSessionStatus } from "../helpers"
import { listPendingInput, type PendingInput } from "../agents/pendingInput"
import { nativeBinding } from "../agents/nativeBindings"
import { storeForPath } from "../agents"
import { sessionAgentsRunning } from "../agents/agentsRunning"
import { runtimeFor, runtimeForSession } from "../agents/runtimes"
import type { RuntimeActivity } from "../agents/runtimeTypes"
import type { AgentStore } from "../agents/types"
import { findJsonlPath } from "../sessionPaths"
import { orchestrationStore } from "../orchestration/storage"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import { agentFailureTitle } from "../../shared/session/agentFailures"
import type { SessionStatusInfo } from "../../shared/session/types"
import { RECENT_ACTIVITY_MS, WORKING_STATUSES } from "../../shared/sessionActivity"
import type { WorkspaceEnvironment, WorkspaceRunContext } from "../../shared/contracts/workspaces"
import { workspaceDetailsForCwd } from "../workspaceTransfer/status"

/**
 * One answer to "is that session done?" for agents driving other sessions.
 *
 * `outcome` folds the three signals a caller would otherwise combine by hand:
 * the runtime's `running` flag (exact for sessions this server manages), the
 * transcript tail status (the only signal for sessions started elsewhere), and
 * the requests a session is blocked on — which leave `running` true forever,
 * so a poll loop on `running` alone hangs on the first permission prompt.
 */

/** `unreachable` is a remote session whose device did not answer. */
export type SessionOutcome = "running" | "needs_input" | "completed" | "error" | "not_found" | "unreachable"

export interface SessionState extends Partial<SessionStatusInfo> {
  sessionId: string
  outcome: SessionOutcome
  live: boolean
  running: boolean
  activeNotifications?: boolean
  waiting: PendingInput[]
  error?: string
  environment?: WorkspaceEnvironment
  run?: WorkspaceRunContext
}

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

/** A transcript the caller already found, so the read skips looking for it. */
export interface KnownTranscript {
  filePath: string
  /** When the session last did something; the transcript's mtime when absent. */
  lastActivityMs?: number
}

/**
 * Whether a mid-flight tail means the session is still working. A runtime
 * holding the session is trusted over the tail, which lags the turn boundary
 * by a flush, except while the session waits on its agents between turns.
 * Without one, the tail is believed only while the transcript, or its agents',
 * is still being written: a session killed partway through a turn keeps a
 * mid-flight tail forever.
 */
async function tailStillWorking(
  sessionId: string,
  status: string | undefined,
  activity: RuntimeActivity,
  transcript: { store: AgentStore; filePath: string; lastActivityMs?: number },
): Promise<boolean> {
  if (!status || !WORKING_STATUSES.has(status)) return false
  if (activity.live) return status === "awaiting_agents"
  const activeAt = transcript.lastActivityMs ?? (await stat(transcript.filePath).catch(() => null))?.mtimeMs ?? 0
  if (Date.now() - activeAt < RECENT_ACTIVITY_MS) return true
  if (status !== "awaiting_agents") return false
  const address = await transcript.store.sessionAddress(transcript.filePath).catch(() => null)
  return address !== null && await sessionAgentsRunning(address.dirName, sessionId)
}

/**
 * Whether a message waiting in the session's queue will start its next turn.
 * Until the dispatcher hands it over, the session still describes the turn
 * before, so a `wait` right after a `send` would return that turn's reply.
 */
async function messageStartsNext(sessionId: string, kind: AgentKind, filePath: string | null): Promise<boolean> {
  const store = orchestrationStore()
  const conversation = store.findConversation(await nativeBinding(sessionId, kind, filePath))
  return conversation !== null && store.startsNext(conversation.id)
}

export async function readSessionState(sessionId: string, known?: KnownTranscript): Promise<SessionState> {
  // The transcript decides whose session it is; a live session whose
  // transcript is not on disk yet falls back to the runtime holding it.
  const filePath = known?.filePath ?? await findJsonlPath(sessionId)
  const store = storeForPath(filePath)
  const runtime = store ? runtimeFor(store.kind, store.instanceId) : runtimeForSession(sessionId)
  if (!runtime) {
    return { sessionId, outcome: "not_found", live: false, running: false, waiting: [] }
  }

  const activity = runtime.activity(sessionId)
  const statusInfo = filePath ? await getSessionStatus(filePath) : undefined
  const waiting = listPendingInput(sessionId)
  const identity = filePath && store?.readIdentity ? await store.readIdentity(filePath).catch(() => null) : null
  const workspace = identity?.cwd ? await workspaceDetailsForCwd(identity.cwd) : {}
  const failure = statusInfo?.failure
  const error = turnErrors.get(sessionId)
    ?? (failure ? `${agentFailureTitle(runtime.kind, failure)} ${failure.message}` : statusInfo?.terminalReason)

  let outcome: SessionOutcome
  if (waiting.length > 0) outcome = "needs_input"
  else if (activity.running) outcome = "running"
  else if (await messageStartsNext(sessionId, runtime.kind, filePath).catch(() => false)) outcome = "running"
  else if (filePath && store && await tailStillWorking(sessionId, statusInfo?.status, activity, { store, filePath, lastActivityMs: known?.lastActivityMs })) outcome = "running"
  else if (error) outcome = "error"
  else outcome = "completed"

  return {
    sessionId,
    outcome,
    ...activity,
    activeNotifications: runtime.descriptor.capabilities.activeNotifications,
    ...statusInfo,
    waiting,
    ...workspace,
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

/** Done with its turn or blocked on someone; an unreachable device may still be working. */
export const isSettled = (state: SessionState) => state.outcome !== "running" && state.outcome !== "unreachable"

export async function waitForSessions(
  sessionIds: readonly string[],
  { mode, timeoutMs, signal, pollMs = 750 }: WaitOptions,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const sessions = await Promise.all(sessionIds.map((id) => readSessionState(id)))
    const done = mode === "all" ? sessions.every(isSettled) : sessions.some(isSettled)
    if (done) return { timedOut: false, sessions }
    if (signal?.aborted || Date.now() >= deadline) return { timedOut: true, sessions }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
  }
}
