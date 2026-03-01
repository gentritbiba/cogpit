// ── Content Blocks ──────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text"
  text: string
}

export interface ThinkingBlock {
  type: "thinking"
  thinking: string
  signature: string
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | ContentBlock[]
  is_error: boolean
}

export interface ImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: string
    data: string
  }
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock

export type UserContent = string | ContentBlock[]

// ── Raw JSONL Message Types ─────────────────────────────────────────────────

interface BaseMessage {
  type: string
  parentUuid?: string | null
  isSidechain?: boolean
  cwd?: string
  sessionId?: string
  version?: string
  gitBranch?: string
  uuid?: string
  timestamp?: string
  userType?: string
  slug?: string
}

/** Summary result from an Agent/Task tool call (new format, v2.1.63+) */
export interface AgentToolUseResult {
  status: string
  prompt: string
  agentId: string
  content: ContentBlock[]
  totalDurationMs?: number
  totalTokens?: number
  totalToolUseCount?: number
  usage?: TokenUsage
}

export interface UserMessage extends BaseMessage {
  type: "user"
  message: {
    role: "user"
    content: UserContent
  }
  isMeta?: boolean
  permissionMode?: string
  thinkingMetadata?: { maxThinkingTokens: number }
  toolUseResult?: AgentToolUseResult
  sourceToolAssistantUUID?: string
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface AssistantMessage extends BaseMessage {
  type: "assistant"
  message: {
    model: string
    id: string
    role: "assistant"
    content: ContentBlock[]
    stop_reason: string | null
    usage: TokenUsage
  }
  requestId?: string
}

/**
 * @deprecated Claude Code v2.1.63+ no longer emits inline agent_progress messages.
 * Subagent results now come as `toolUseResult` on the tool_result UserMessage.
 * This interface is kept for backward compat with old sessions and for
 * subagentWatcher.ts which synthesizes these for live progress display.
 * New features should use AgentToolUseResult instead.
 */
export interface AgentProgressData {
  type: "agent_progress"
  message: {
    type: "user" | "assistant"
    message: { role: string; content: unknown }
    uuid?: string
    timestamp?: string
  }
  prompt: string
  agentId: string
}

export interface HookProgressData {
  type: "hook_progress"
  [key: string]: unknown
}

export interface ProgressMessage extends BaseMessage {
  type: "progress"
  data: AgentProgressData | HookProgressData
  parentToolUseID?: string
  toolUseID?: string
}

export interface SystemMessage extends BaseMessage {
  type: "system"
  subtype?: string
  durationMs?: number
  isMeta?: boolean
}

export interface FileHistorySnapshotMessage extends BaseMessage {
  type: "file-history-snapshot"
  messageId?: string
  snapshot?: {
    messageId: string
    trackedFileBackups: Record<string, unknown>
    timestamp: string
  }
  isSnapshotUpdate?: boolean
}

export interface SummaryMessage extends BaseMessage {
  type: "summary"
  leafUuid?: string
  summary?: string
}

export type RawMessage =
  | UserMessage
  | AssistantMessage
  | ProgressMessage
  | SystemMessage
  | FileHistorySnapshotMessage
  | SummaryMessage

// ── Parsed Structures ───────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result: string | null
  isError: boolean
  timestamp: string
}

export interface SubAgentMessage {
  agentId: string
  agentName: string | null
  subagentType: string | null
  type: "user" | "assistant"
  content: unknown
  toolCalls: ToolCall[]
  thinking: string[]
  text: string[]
  timestamp: string
  tokenUsage: TokenUsage | null
  model: string | null
  isBackground: boolean
  /** Summary fields from toolUseResult (new format, v2.1.63+) */
  prompt?: string
  status?: string
  durationMs?: number
  toolUseCount?: number
}

/** Ordered content block within a turn – preserves chronological order */
export type TurnContentBlock =
  | { kind: "thinking"; blocks: ThinkingBlock[]; timestamp?: string }
  | { kind: "text"; text: string[]; timestamp?: string }
  | { kind: "tool_calls"; toolCalls: ToolCall[]; timestamp?: string }
  | { kind: "sub_agent"; messages: SubAgentMessage[]; timestamp?: string }
  | { kind: "background_agent"; messages: SubAgentMessage[]; timestamp?: string }

export interface Turn {
  id: string
  userMessage: UserContent | null
  /** Chronologically ordered content blocks for rendering */
  contentBlocks: TurnContentBlock[]
  // Flat arrays kept for search, stats, and backward compat
  thinking: ThinkingBlock[]
  assistantText: string[]
  toolCalls: ToolCall[]
  subAgentActivity: SubAgentMessage[]
  timestamp: string
  durationMs: number | null
  tokenUsage: TokenUsage | null
  model: string | null
  /** Set when a compaction happened before this turn */
  compactionSummary?: string
}

export interface SessionStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalCostUSD: number
  toolCallCounts: Record<string, number>
  errorCount: number
  totalDurationMs: number
  turnCount: number
}

export interface ParsedSession {
  sessionId: string
  version: string
  gitBranch: string
  cwd: string
  slug: string
  model: string
  turns: Turn[]
  stats: SessionStats
  rawMessages: RawMessage[]
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
}

// ── Undo/Redo & Branching ────────────────────────────────────────────────

export interface ArchivedToolCall {
  type: "Edit" | "Write"
  filePath: string
  oldString?: string   // Edit only
  newString?: string   // Edit only
  replaceAll?: boolean // Edit only
  content?: string     // Write only
}

export interface ArchivedTurn {
  index: number
  userMessage: string | null
  toolCalls: ArchivedToolCall[]
  thinkingBlocks: string[]
  assistantText: string[]
  timestamp: string
  model: string | null
}

export interface Branch {
  id: string
  createdAt: string
  branchPointTurnIndex: number
  label: string
  turns: ArchivedTurn[]
  jsonlLines: string[]
  /** Branches that were nested within the archived range, preserved for restore */
  childBranches?: Branch[]
}

export interface UndoState {
  sessionId: string
  currentTurnIndex: number
  totalTurns: number
  branches: Branch[]
  activeBranchId: string | null
}
