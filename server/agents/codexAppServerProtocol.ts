import type { SpawnOptionsWithoutStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import type {
  ElicitationAction,
  ElicitationContent,
  MissionControlElicitationField,
} from "../../shared/contracts/agentPrompts"

export type JsonRpcId = string | number
export type JsonObject = Record<string, unknown>

export const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval"
export const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval"
export const MCP_ELICITATION_METHOD = "mcpServer/elicitation/request"
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
  /** How often an idle connection re-checks the installed Codex version. */
  versionCheckIntervalMs?: number
  /** Codex version currently on disk; null when it cannot be determined. */
  readInstalledVersion?: () => Promise<string | null>
  /** Tells a thread's viewers about a server request that was refused for them. */
  reportError?: (threadId: string, message: string) => void
}

export interface CodexNotification<T = unknown> {
  method: string
  params: T
}

export type CodexNotificationListener = (
  notification: CodexNotification,
) => void

/** `writeStdin` is a command approval for typing into a terminal that is already running. */
export type PendingApprovalKind =
  | "commandExecution"
  | "writeStdin"
  | "fileChange"
  | "mcpToolCall"
export type ApprovalDecision = "allow" | "allow_always" | "deny"

/** An MCP tool call awaiting approval, as the elicitation asking for it describes it. */
export interface McpToolCallRequest {
  serverName: string
  /** Codex's own question — the one field that always names the tool. */
  message: string
  connectorName?: string
  toolTitle?: string
  toolDescription?: string
  /** Arguments, under the names Codex displays them by. */
  toolParams?: JsonObject
}

export interface PendingApproval {
  requestId: JsonRpcId
  kind: PendingApprovalKind
  method:
    | typeof COMMAND_APPROVAL_METHOD
    | typeof FILE_APPROVAL_METHOD
    | typeof MCP_ELICITATION_METHOD
  threadId: string
  /** Null when the app-server could not tie an MCP request to a turn. */
  turnId: string | null
  /** Absent for MCP tool calls, which the protocol does not link to an item. */
  itemId?: string
  requestedAt: number
  reason?: string
  command?: string
  cwd?: string
  grantRoot?: string
  approvalId?: string
  networkApprovalContext?: unknown
  mcpToolCall?: McpToolCallRequest
  /** UI-level decisions that are valid for this specific server request. */
  availableDecisions: ApprovalDecision[]
  params: JsonObject
}

/** An MCP server's own request for input, parked until the user answers it. */
export interface PendingElicitation {
  requestId: JsonRpcId
  threadId: string
  turnId: string | null
  requestedAt: number
  serverName: string
  message: string
  mode: "form" | "url"
  url?: string
  /** Empty for `url` mode and for a bare confirm with no schema. */
  fields: MissionControlElicitationField[]
}

export interface ElicitationResponse {
  action: ElicitationAction
  content?: ElicitationContent
}

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
