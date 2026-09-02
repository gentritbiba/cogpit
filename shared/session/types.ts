// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.

// ── Agent identity ──────────────────────────────────────────────────────────
//
// This module is the leaf of the session core: it imports nothing, so it is the
// only place an identifier can live and still be reachable from the renderer,
// the server, Electron and the standalone cogpit-memory package alike.

/** The agent CLIs Cogpit can drive. */
export type AgentKind = "claude" | "codex" | "copilot"

/**
 * Every agent kind, in transcript-detection order. Codex and Copilot carry
 * positive discriminators in their records; Claude is the terminal fallback and
 * must stay last.
 */
export const AGENT_KINDS: readonly AgentKind[] = ["codex", "copilot", "claude"]

// ── Session status ──────────────────────────────────────────────────────────

export type SessionStatus =
  | "idle"
  | "thinking"
  | "tool_use"
  | "processing"
  | "completed"
  | "compacting"
  | "deferred"
  | "awaiting_agents"

export interface SessionStatusInfo {
  status: SessionStatus
  /** Name of the tool currently being used (if status is tool_use) */
  toolName?: string
  /** Number of pending queue items (user messages waiting to be processed) */
  pendingQueue?: number
  /** Why the session terminated (from Claude Code's terminal_reason). Only set for non-normal endings. */
  terminalReason?: string
  /** Number of background agents/workflows still running (status awaiting_agents) */
  pendingAgents?: number
  /** Short descriptions of the pending background agents, oldest first */
  pendingAgentDescriptions?: string[]
}

/** A raw transcript record, before any agent-specific interpretation. */
export type RawRecord = { type: string; [key: string]: unknown }

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
  is_error?: boolean
}

export interface Base64MediaSource {
  type: "base64"
  media_type: string
  data: string
}

export interface ImageBlock {
  type: "image"
  source: Base64MediaSource
}

export interface DocumentBlock {
  type: "document"
  source: Base64MediaSource
}

export interface AudioBlock {
  type: "audio"
  source: Base64MediaSource
}

/** Claude emits this when an API request falls back from one model to another. */
export interface FallbackBlock {
  type: "fallback"
  from: { model: string }
  to: { model: string }
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock
  | AudioBlock
  | FallbackBlock

export type UserContent = string | ContentBlock[]

// ── Raw JSONL Message Types ─────────────────────────────────────────────────

interface BaseMessage {
  type: string
  [key: string]: unknown
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
  /**
   * Set on the synthetic user message Claude Code writes after a compaction.
   * Its content is the real compaction summary wrapped in resume boilerplate —
   * `compact_boundary.content` is only ever the fixed string "Conversation
   * compacted", so this message is the sole source of the summary text.
   */
  isCompactSummary?: boolean
  /**
   * Why Claude Code wrote this record. `"task-notification"` marks a
   * background task reporting back, not a prompt the reader typed. Absent on
   * records written before Claude Code added the field (pre-2.1.220).
   */
  origin?: { kind?: string } | null
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
  /** "fast" when the turn ran in fast mode (billed at a higher tier on Opus 4.6/4.7) */
  speed?: string
  /**
   * Claude Code 2.1.19x+ reports the thinking slice of `output_tokens`
   * exactly. Already counted inside output_tokens — never add it to a cost sum.
   */
  output_tokens_details?: { thinking_tokens?: number }
}

/**
 * What drove a response, when Claude Code could attribute it (CC 2.1.17x+).
 * Written as flat `attribution*` fields on the assistant record.
 */
export interface MessageAttribution {
  /** Subagent type, e.g. "Explore", "implementer", "workflow-subagent". */
  agent?: string
  skill?: string
  plugin?: string
  mcpServer?: string
  mcpTool?: string
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
  /**
   * Reasoning effort this response ran at (CC 2.1.212+): low | medium | high |
   * xhigh | max. Codex spells its own levels differently (e.g. "trivial"), so
   * this stays a plain string rather than a union.
   */
  effort?: string
  attributionAgent?: string
  attributionSkill?: string
  attributionPlugin?: string
  attributionMcpServer?: string
  attributionMcpTool?: string
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
  compactMetadata?: CompactionMeta
}

export interface CompactionMeta {
  trigger: "auto" | "manual"
  preTokens: number
  postTokens?: number
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

/** Claude Code persists prompts submitted during an active turn as queue operations. */
export interface QueueOperationMessage extends BaseMessage {
  type: "queue-operation"
  operation: "enqueue" | "dequeue" | "remove" | string
  content?: string | null
}

/**
 * Claude Code persists the text of a prompt queued mid-turn here, not on the
 * queue-operation record. `commandMode` separates prompts the user typed
 * ("prompt") from Claude's own injected notices ("task-notification").
 */
export interface AttachmentMessage extends BaseMessage {
  type: "attachment"
  attachment?: {
    type?: string
    prompt?: string | ContentBlock[] | null
    commandMode?: string
    timestamp?: string
    /**
     * Who queued this prompt. `"human"` is the reader typing mid-turn;
     * `"peer"` is another agent sending this session a message. `body` is the
     * message with its envelope already stripped, so it beats re-parsing
     * `prompt`. Absent on records written before Claude Code added the field.
     */
    origin?: {
      kind?: string
      from?: string
      name?: string
      senderTaskId?: string
      body?: string
    } | null
  } | null
}

/**
 * Written when a session enters or leaves a `.claude/worktrees/*` checkout.
 * The record is the session's current worktree state, so a later one supersedes
 * an earlier one, and a null `worktreeSession` means the session left.
 */
export interface WorktreeStateMessage extends BaseMessage {
  type: "worktree-state"
  worktreeSession?: {
    originalCwd?: string
    preEnterOriginalCwd?: string
    worktreePath?: string
    worktreeName?: string
    worktreeBranch?: string
    originalBranch?: string
    originalHeadCommit?: string
    sessionId?: string
  } | null
}

/** The agent type a session was launched as, e.g. "general-purpose". */
export interface AgentSettingMessage extends BaseMessage {
  type: "agent-setting"
  agentSetting?: string
}

/*
 * Known-ignored sidecar records, deliberately untyped:
 * - "last-prompt": duplicates the prompt Cogpit already derives from the transcript.
 * - "atis-latch": its `atis` payload is an empty string in every observed transcript.
 */

export type RawMessage =
  | UserMessage
  | AssistantMessage
  | ProgressMessage
  | SystemMessage
  | FileHistorySnapshotMessage
  | SummaryMessage
  | QueueOperationMessage
  | AttachmentMessage

// ── Parsed Structures ───────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result: string | null
  /** Binary images returned by a tool, when the provider persists them. */
  resultImages?: ImageBlock[]
  isError: boolean
  timestamp: string
  /** Set by parser when a PostToolUse hook replaced this tool's output */
  outputReplacedByHook?: boolean
  /** Total duration of PostToolUse hooks attached to this call, summed in ms */
  hookDurationMs?: number
}

export interface SubAgentMessage {
  agentId: string
  /** The Task/Agent tool_use id this agent belongs to (streaming overlay key) */
  parentToolUseId?: string
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
  | { kind: "queued_prompt"; content: string; timestamp?: string }
  /**
   * A message another agent sent this session mid-turn. Distinct from
   * `queued_prompt`, which is the reader's own text. `reply` is filled by the
   * pairing pass when a later SendMessage answered this sender.
   *
   * Deliberately carries no sender task id. `origin.senderTaskId` on the record
   * identifies the sending agent's *task*, not the message — one agent's
   * question and its later done-report share an id — so it is useless as a
   * per-message key and destructive as a dedup key.
   */
  | {
      kind: "agent_message"
      sender: string
      body: string
      timestamp?: string
      reply?: { summary: string; timestamp: string }
    }
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
  /**
   * A background task reporting back, which resumes the turn that launched it
   * rather than opening one of its own. `content` is the raw record text —
   * one or more `<task-notification>` blocks, possibly inside a
   * `<system-reminder>` envelope (Claude Code 2.1.234+) — left unparsed here
   * for the same reason `queued_prompt` is: the renderers own that grammar.
   */
  | { kind: "task_notification"; content: string; timestamp?: string }

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
  /**
   * Summary of the compaction that happened before this turn, as written by
   * the compacting model. Absent when the transcript records the boundary but
   * not the summary (e.g. the session ended right after compacting).
   */
  compactionSummary?: string
  /** Trigger and token counts of the compaction that happened before this turn */
  compactionMeta?: CompactionMeta
  /**
   * Reasoning effort the turn ran at, when the transcript recorded one.
   * A turn spanning several assistant messages reports the last one, since
   * effort can be changed mid-session.
   */
  effort?: string
  /**
   * What drove this turn — skill, plugin, MCP server, subagent type. Merged
   * across the turn's assistant messages, since a turn can start under a skill
   * and later reach for an MCP tool. Undefined when nothing was attributed.
   */
  attribution?: MessageAttribution
  /**
   * Set when this turn was opened without its start record — the parse window
   * began mid-turn. Such a turn is the newer half of a byte-boundary cut and
   * must be stitched onto the previous turn once the older page arrives.
   */
  isFragment?: boolean
}

export interface SessionStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  toolCallCounts: Record<string, number>
  errorCount: number
  totalDurationMs: number
  turnCount: number
}

export interface ParseSessionOptions {
  /** Skip aggregate cost/token work and raw-message retention for index-only consumers. */
  skipStats?: boolean
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
   * The agent that produced this session, as determined by the parser from the
   * transcript's own bytes. This is the parser's finding, not the app's source
   * of truth — the session's dirName is (see `shared/session/agents.ts`).
   */
  agentKind?: AgentKind
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
