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

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "StopFailure"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "PermissionDenied"
  | "TaskCreated"
  | "WorktreeCreate"
  | "CwdChanged"
  | "FileChanged"
  | "Elicitation"
  | "ElicitationResult"
  | "Notification"

export interface HookProgressData {
  type: "hook_progress"
  /** Event name (newer SDK: hook_event_name; older SDK: hookEvent) */
  hook_event_name?: HookEventName | string
  /** Older SDK field for event name (e.g. "PostToolUse") */
  hookEvent?: HookEventName | string
  /** Human-readable hook name like "PostToolUse:Read" (older SDK) */
  hookName?: string
  /** Source of the hook configuration: "settings" | "plugin" | "skill" */
  source?: string
  /** Tool call this hook is associated with (for Pre/PostToolUse) */
  tool_use_id?: string
  /** Tool name (Pre/PostToolUse) */
  tool_name?: string
  /** Hook command line that ran */
  command?: string
  /** stdout/stderr from the hook command */
  output?: string
  stderr?: string
  /** Exit code */
  exit_code?: number
  /** Decision returned by hook (allow/deny/block/ask/defer) */
  decision?: string
  /** Duration in milliseconds (PostToolUse, 2.1.119+) */
  duration_ms?: number
  /** Hook-specific output (e.g., updatedToolOutput, sessionTitle) */
  hookSpecificOutput?: Record<string, unknown>
  /** Permits arbitrary additional fields without coupling */
  [key: string]: unknown
}

export interface ParsedHookEvent {
  /** Event name like "PreToolUse" */
  eventName: string
  /** Source: settings/plugin/skill */
  source?: string
  /** Tool the hook is gated on (for Pre/PostToolUse) */
  toolName?: string
  toolUseId?: string
  /** Command that ran */
  command?: string
  output?: string
  stderr?: string
  exitCode?: number
  decision?: string
  /** Duration in ms */
  durationMs?: number
  /** PostToolUse hooks (2.1.121) can replace tool output via updatedToolOutput */
  updatedToolOutput?: string
  /** UserPromptSubmit hooks (2.1.94) can set sessionTitle */
  sessionTitle?: string
  /** WorktreeCreate hooks (2.1.84) return worktreePath */
  worktreePath?: string
  timestamp: string
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
  content?: string
  compactMetadata?: {
    trigger: "auto" | "manual"
    preTokens: number
  }
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
  | { kind: "hook_event"; events: ParsedHookEvent[]; timestamp?: string }
  | { kind: "plan_mode"; plan: string; planFilePath?: string; status: "pending" | "approved" | "rejected"; toolCalls: ToolCall[]; timestamp?: string }
  /**
   * Away summary / recap block — emitted as a system message with
   * subtype "away_summary" (Claude Code v2.1.108+, observed in production
   * JSONL as of 2026-04). The /recap command produces the same shape.
   * Content is plain text (may be long-form prose, not always markdown).
   */
  | { kind: "recap"; content: string; timestamp?: string }

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
  /** Session display name set via `--name` CLI flag. */
  name: string
  model: string
  turns: Turn[]
  stats: SessionStats
  /**
   * Raw JSONL message objects. Widened from `RawMessage[]` to support multiple
   * provider formats (Claude Code and Codex) without a discriminated union at
   * every call site. Use `agentKind` to distinguish formats when needed.
   */
  rawMessages: Array<{ type: string; [key: string]: unknown }>
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
  /**
   * The provider that produced this session. Set by the parser when the
   * format is known. Consumers can use this instead of inspecting rawMessages.
   */
  agentKind?: "claude" | "codex"
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
