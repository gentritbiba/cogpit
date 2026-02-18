/**
 * Test fixtures for Cogpit - realistic JSONL mock data
 * matching the actual Claude Code JSONL format.
 */

import type {
  UserMessage,
  AssistantMessage,
  ProgressMessage,
  SystemMessage,
  SummaryMessage,
  ContentBlock,
  TokenUsage,
  Turn,
  ToolCall,
} from "@/lib/types"

// ── Factory Helpers ─────────────────────────────────────────────────────────

let msgCounter = 0

function nextId(): string {
  return `msg_${++msgCounter}`
}

export function resetFixtureCounter() {
  msgCounter = 0
}

// ── User Messages ───────────────────────────────────────────────────────────

export function userMsg(
  content: string | ContentBlock[],
  overrides: Partial<UserMessage> = {}
): UserMessage {
  return {
    type: "user",
    uuid: nextId(),
    timestamp: "2025-01-15T10:00:00Z",
    sessionId: "test-session-1",
    message: { role: "user", content },
    ...overrides,
  }
}

export function toolResultMsg(
  toolUseId: string,
  result: string,
  isError = false,
  overrides: Partial<UserMessage> = {}
): UserMessage {
  return userMsg(
    [{ type: "tool_result", tool_use_id: toolUseId, content: result, is_error: isError }],
    overrides
  )
}

// ── Assistant Messages ──────────────────────────────────────────────────────

const defaultUsage: TokenUsage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 100,
}

export function assistantMsg(
  content: ContentBlock[],
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  const id = nextId()
  return {
    type: "assistant",
    uuid: id,
    timestamp: "2025-01-15T10:00:01Z",
    sessionId: "test-session-1",
    message: {
      model: "claude-opus-4-6-20250115",
      id,
      role: "assistant",
      content,
      stop_reason: "end_turn",
      usage: { ...defaultUsage },
    },
    ...overrides,
  }
}

export function textAssistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return assistantMsg([{ type: "text", text }], overrides)
}

export function thinkingAssistant(
  thinking: string,
  text: string,
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  return assistantMsg(
    [
      { type: "thinking", thinking, signature: "sig-test" },
      { type: "text", text },
    ],
    overrides
  )
}

export function toolUseAssistant(
  toolName: string,
  input: Record<string, unknown>,
  toolUseId?: string,
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  const id = toolUseId ?? nextId()
  return assistantMsg(
    [{ type: "tool_use", id, name: toolName, input }],
    overrides
  )
}

// ── System & Progress Messages ──────────────────────────────────────────────

export function turnDurationMsg(durationMs: number): SystemMessage {
  return {
    type: "system",
    subtype: "turn_duration",
    durationMs,
    uuid: nextId(),
    timestamp: "2025-01-15T10:00:02Z",
  }
}

export function summaryMsg(summary = "Conversation compacted"): SummaryMessage {
  return {
    type: "summary",
    summary,
    uuid: nextId(),
    timestamp: "2025-01-15T10:00:03Z",
  }
}

export function agentProgressMsg(
  agentId: string,
  parentToolUseID: string,
  innerType: "user" | "assistant",
  innerContent: unknown,
  overrides: Partial<ProgressMessage> = {}
): ProgressMessage {
  return {
    type: "progress",
    uuid: nextId(),
    timestamp: "2025-01-15T10:00:01Z",
    sessionId: "test-session-1",
    parentToolUseID,
    data: {
      type: "agent_progress",
      agentId,
      prompt: "",
      normalizedMessages: [],
      message: {
        type: innerType,
        message: innerType === "assistant"
          ? {
              model: "claude-sonnet-4-5-20250115",
              id: nextId(),
              role: "assistant",
              content: innerContent,
              stop_reason: "end_turn",
              usage: { input_tokens: 500, output_tokens: 200 },
            }
          : { role: "user", content: innerContent },
        uuid: nextId(),
        timestamp: "2025-01-15T10:00:01Z",
      },
    } as ProgressMessage["data"],
    ...overrides,
  }
}

// ── JSONL Builders ──────────────────────────────────────────────────────────

export function toJsonl(messages: Array<Record<string, unknown>>): string {
  return messages.map((m) => JSON.stringify(m)).join("\n")
}

// ── Preset Sessions ─────────────────────────────────────────────────────────

/** Simple 1-turn session: user asks, assistant responds with text */
export function simpleSession(): string {
  return toJsonl([
    userMsg("Hello, how are you?"),
    textAssistant("I'm doing great! How can I help you today?"),
    turnDurationMsg(1500),
  ])
}

/** 2-turn session with tool use */
export function toolUseSession(): string {
  const toolId = "tool_1"
  return toJsonl([
    userMsg("Read the file src/main.ts"),
    toolUseAssistant("Read", { file_path: "src/main.ts" }, toolId),
    toolResultMsg(toolId, 'console.log("hello")'),
    textAssistant("The file contains a simple hello world program."),
    turnDurationMsg(2000),
    userMsg("Now edit it"),
    toolUseAssistant("Edit", {
      file_path: "src/main.ts",
      old_string: 'console.log("hello")',
      new_string: 'console.log("hello world")',
    }, "tool_2"),
    toolResultMsg("tool_2", "File edited successfully"),
    textAssistant("Done! I updated the log message."),
    turnDurationMsg(1000),
  ])
}

/** Session with thinking blocks */
export function thinkingSession(): string {
  return toJsonl([
    userMsg("Solve this complex problem"),
    thinkingAssistant(
      "Let me think about this step by step...",
      "After careful analysis, here's the solution."
    ),
    turnDurationMsg(5000),
  ])
}

/** Session with metadata for extraction tests */
export function metadataSession(): string {
  return toJsonl([
    userMsg("Start", {
      sessionId: "session-abc-123",
      version: "1.0.0",
      gitBranch: "main",
      cwd: "/home/user/project",
      slug: "my-project",
    }),
    assistantMsg([{ type: "text", text: "Ready!" }], {
      sessionId: "session-abc-123",
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_model",
        role: "assistant",
        content: [{ type: "text", text: "Ready!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }),
  ])
}

/** Session with compaction (summary message) */
export function compactionSession(): string {
  return toJsonl([
    userMsg("First message"),
    textAssistant("First response"),
    turnDurationMsg(1000),
    userMsg("Second message"),
    textAssistant("Second response"),
    turnDurationMsg(1000),
    summaryMsg("Context compacted after 2 turns"),
    userMsg("Third message after compaction"),
    textAssistant("Third response"),
    turnDurationMsg(1000),
  ])
}

/** Session with sub-agent progress messages */
export function subAgentSession(): string {
  const taskToolId = "task_tool_1"
  return toJsonl([
    userMsg("Use a team to solve this"),
    toolUseAssistant("Task", { prompt: "Research the topic" }, taskToolId),
    agentProgressMsg("agent-1", taskToolId, "assistant", [
      { type: "text", text: "Researching..." },
    ]),
    agentProgressMsg("agent-1", taskToolId, "assistant", [
      { type: "tool_use", id: "sub_tool_1", name: "WebSearch", input: { query: "test" } },
    ]),
    toolResultMsg(taskToolId, "Research complete"),
    textAssistant("The team finished the research."),
    turnDurationMsg(3000),
  ])
}

// ── Turn Builders (for undo-engine tests) ───────────────────────────────────

export function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: nextId(),
    userMessage: "test message",
    contentBlocks: [],
    thinking: [],
    assistantText: ["test response"],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2025-01-15T10:00:00Z",
    durationMs: 1000,
    tokenUsage: { ...defaultUsage },
    model: "claude-opus-4-6-20250115",
    ...overrides,
  }
}

export function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: nextId(),
    name: "Read",
    input: { file_path: "test.ts" },
    result: "file contents",
    isError: false,
    timestamp: "2025-01-15T10:00:00Z",
    ...overrides,
  }
}

export function makeEditToolCall(
  filePath: string,
  oldString: string,
  newString: string,
  overrides: Partial<ToolCall> = {}
): ToolCall {
  return makeToolCall({
    name: "Edit",
    input: { file_path: filePath, old_string: oldString, new_string: newString },
    result: "File edited",
    ...overrides,
  })
}

export function makeWriteToolCall(
  filePath: string,
  content: string,
  overrides: Partial<ToolCall> = {}
): ToolCall {
  return makeToolCall({
    name: "Write",
    input: { file_path: filePath, content },
    result: "File written",
    ...overrides,
  })
}
