import type { SpawnOptionsWithoutStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"

export type JsonRpcId = string | number
export type JsonObject = Record<string, unknown>

export const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval"
export const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval"
export const CURRENT_TIME_METHOD = "currentTime/read"

export interface CodexAppServerProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: "error", listener: (error: Error) => void): this
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this
}

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => CodexAppServerProcess

export interface CodexAppServerOptions {
  spawn?: CodexAppServerSpawn
  command?: string
  requestTimeoutMs?: number
  clientVersion?: string
  now?: () => number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

export interface CodexNotification<T = unknown> {
  method: string
  params: T
}

export type CodexNotificationListener = (
  notification: CodexNotification,
) => void

export type PendingApprovalKind = "commandExecution" | "fileChange"
export type ApprovalDecision = "allow" | "allow_always" | "deny"

export interface PendingApproval {
  requestId: JsonRpcId
  kind: PendingApprovalKind
  method: typeof COMMAND_APPROVAL_METHOD | typeof FILE_APPROVAL_METHOD
  threadId: string
  turnId: string
  itemId: string
  requestedAt: number
  reason?: string
  command?: string
  cwd?: string
  grantRoot?: string
  approvalId?: string
  networkApprovalContext?: unknown
  /** UI-level decisions that are valid for this specific server request. */
  availableDecisions: ApprovalDecision[]
  params: JsonObject
}

export type ApprovalListener = (
  threadId: string,
  approvals: readonly PendingApproval[],
) => void

export interface CodexThread extends JsonObject {
  id: string
  parentThreadId?: string | null
}

export interface CodexTurn extends JsonObject {
  id: string
  status?: string
}

export type ThreadStartParams = JsonObject

export interface ThreadResumeParams extends JsonObject {
  threadId: string
}

export interface UserInput extends JsonObject {
  type: string
}

export interface TurnStartParams extends JsonObject {
  threadId: string
  input: UserInput[]
}

export interface TurnSteerParams extends JsonObject {
  threadId: string
  input: UserInput[]
  expectedTurnId?: string
}

export interface ThreadGoal extends JsonObject {
  threadId: string
  objective: string
  status: string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

export interface ThreadGoalSetParams extends JsonObject {
  threadId: string
  objective?: string | null
  status?: string | null
  tokenBudget?: number | null
}

export type InitializeResult = JsonObject

export interface ThreadResponse extends JsonObject {
  thread: CodexThread
}

export interface TurnResponse extends JsonObject {
  turn: CodexTurn
}

export interface TurnSteerResponse extends JsonObject {
  turnId: string
}

export interface ThreadGoalResponse extends JsonObject {
  goal: ThreadGoal | null
}

export interface ThreadGoalClearResponse extends JsonObject {
  cleared: boolean
}

/**
 * Capabilities Cogpit actually implements on the app-server connection.
 *
 * Experimental API opt-in is deliberately off: it is a broad protocol switch,
 * not a declaration for the individual experimental methods Cogpit supports.
 * Stable client requests such as goals remain available without it.
 */
export const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
} as const
