import type { MissionControlQuestion } from "../../shared/contracts/missionControl"
import type {
  AgentDescriptor,
  AgentKind,
  PermissionsConfig,
} from "../../shared/session/agent-descriptors"

/**
 * The live side of an agent: the CLI process or RPC connection Cogpit talks to,
 * as opposed to the transcript grammar (`AgentFormat`) or the files on disk
 * (`AgentStore`).
 *
 * The three CLIs share nothing below this line — an in-process Agent SDK query,
 * a JSONL-over-stdio app-server, and a vscode-jsonrpc session server. Each
 * adapter wraps the transport module that already speaks its protocol; none of
 * them reimplements it. What the adapters add is a single vocabulary, so a
 * route can start, send to, interrupt, stop and answer any agent without
 * naming one.
 */

export type ApprovalDecision = "allow" | "allow_always" | "deny"

export interface ImageAttachment {
  data: string
  mediaType: string
}

/** Cogpit's access picker, before each agent translates it to its own policy. */
export type AgentPermissions = PermissionsConfig

/** Settings a caller may attach to a spawn or a send. */
export interface AgentTurnSettings {
  permissions?: AgentPermissions
  model?: string
  effort?: string
  fastMode?: boolean
  ultracode?: boolean
  mcpConfig?: string | null
}

export interface StartSessionRequest extends AgentTurnSettings {
  /** Project dirName the session is being created under. */
  dirName: string
  /** Absolute working directory the agent runs in. */
  cwd: string
  message?: string
  images?: ImageAttachment[]
  /** Session title, applied however the agent supports it. */
  name?: string
  worktreeName?: string
  /**
   * True for `/api/new-session`: run the CLI once and report the session only
   * after that run finishes, rather than as soon as the transcript exists.
   * Only Claude distinguishes the two; the others ignore it.
   */
  oneShot?: boolean
}

export interface StartedSession {
  sessionId: string
  dirName: string
  /** Transcript path relative to the agent's sessions root. */
  fileName: string
  filePath: string
  /** Transcript bytes already on disk, when the spawn managed to read them. */
  initialContent?: string
}

export interface SendRequest extends AgentTurnSettings {
  message?: string
  images?: ImageAttachment[]
  /** Working directory, when the caller knows it; recovered otherwise. */
  cwd?: string
  /** Transcript path, when the caller already resolved it. */
  filePath?: string | null
}

/** What became of a turn, normalised across three unrelated completion signals. */
export interface TurnResult {
  isError: boolean
  message?: string
}

export interface SendOutcome {
  /**
   * `enqueued`/`steered` mean the message joined a turn already running;
   * `started` opened a new one; `busy` means the agent refused it.
   */
  delivery: "enqueued" | "steered" | "started" | "busy"
  turnId?: string
  /**
   * Present only when this agent reports the turn's outcome on the request that
   * started it — a Claude resume and the legacy Codex CLI both do, and their
   * HTTP responses stay open until it settles. The others report completion out
   * of band through the transcript, and a caller must not wait for them.
   */
  completion?: Promise<TurnResult>
}

/** A pending tool approval, in the shape the permission bar renders. */
export interface PendingApproval {
  sessionId: string
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  /** Scoped permission rules the agent proposed alongside the request. */
  suggestions?: Array<Record<string, unknown>>
  timestamp: number
  availableDecisions: ApprovalDecision[]
}

export type PendingQuestion = MissionControlQuestion

/**
 * What `stopAll` achieved. Failures are counted per item, not per agent,
 * because a kill-all reports how many turns it could not stop — and the
 * granularities genuinely differ: Codex interrupts one turn at a time while
 * Copilot destroys one session at a time.
 */
export interface StopAllResult {
  stopped: number
  failed: number
}

/** What a batch approval achieved, for the response the permission bar reads. */
export interface ApprovalBatchResult {
  count: number
  toolNames: string[]
}

export type UserQuestionAnswers = Record<string, string> | string[] | string

/**
 * A failure a route can turn into an HTTP response without knowing which agent
 * produced it. Anything else that escapes an adapter is an unexpected error and
 * becomes a 500.
 */
export class AgentRuntimeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AgentRuntimeError"
  }
}

export interface AgentRuntime {
  readonly kind: AgentKind
  readonly descriptor: AgentDescriptor
  /** Create a session and open its first turn. */
  start(req: StartSessionRequest): Promise<StartedSession>
  /** Deliver a message, resuming the session first when it is not live. */
  send(sessionId: string, req: SendRequest): Promise<SendOutcome>
  /** Stop the turn in flight, keeping the session. False when none was. */
  interrupt(sessionId: string): Promise<boolean>
  /** End the session. False when this runtime held nothing for the id. */
  stop(sessionId: string): Promise<boolean>
  /** Stop everything this runtime holds. */
  stopAll(): Promise<StopAllResult>
  /** Delete the session's own record of itself, then its transcript. */
  deleteSession(sessionId: string, filePath: string): Promise<void>
  /**
   * `live`: a connection exists that can take a follow-up without a resume.
   * `running`: a turn is in flight right now.
   */
  activity(sessionId: string): { live: boolean; running: boolean }
  /** True when this runtime holds any state for the id. */
  hasSession(sessionId: string): boolean
  /** Sessions with work in flight. */
  listActive(): Array<{ sessionId: string; turnId?: string }>
  /** Approvals blocking a session, or every one this runtime holds. */
  listPendingApprovals(sessionId?: string): PendingApproval[]
  respondToApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean>
  /**
   * Answer every approval a session is blocked on. Batch semantics are the
   * agent's own — atomic, validate-then-parallel, or sequential with a
   * re-entrancy check — but none of them may widen a decision, so all three go
   * through `selectAvailableDecision` first.
   */
  respondToAllApprovals(
    sessionId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalBatchResult>
  /** Questions blocking a session, or every one this runtime holds. */
  listPendingQuestions(sessionId?: string): PendingQuestion[]
  answerQuestion(
    sessionId: string,
    questionId: string,
    answers: UserQuestionAnswers,
  ): Promise<boolean>
  /** Account, usage and capability snapshot, in this agent's own wire shape. */
  describeRuntime(force?: boolean): Promise<unknown>
  /** Tear down the transport itself. */
  shutdown(): Promise<void>
}

/**
 * Pick the decision to actually apply, without ever widening access.
 *
 * "Always allow" may safely degrade to a one-time allow when an agent does not
 * offer session grants for a request; a one-time allow never broadens into one,
 * and a deny never becomes an allow. Null means the request cannot be answered
 * this way at all, and the caller must say so rather than silently pick
 * something else — which is what the Copilot batch path used to do.
 */
export function selectAvailableDecision(
  available: readonly ApprovalDecision[],
  requested: ApprovalDecision,
): ApprovalDecision | null {
  if (available.includes(requested)) return requested
  if (requested === "allow_always" && available.includes("allow")) return "allow"
  return null
}
