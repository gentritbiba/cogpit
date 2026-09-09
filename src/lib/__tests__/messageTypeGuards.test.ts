import { describe, it, expect } from "vitest"
import {
  isUserMessage,
  isAssistantMessage,
  isProgressMessage,
  isSystemMessage,
  isSummaryMessage,
  isCompactBoundary,
} from "../../../shared/session/messageTypeGuards"
import type {
  RawMessage,
  UserMessage,
  AssistantMessage,
  ProgressMessage,
  SystemMessage,
  SummaryMessage,
  TokenUsage,
} from "../../../shared/session/types"

// ── Minimal fixture factories ────────────────────────────────────────────────

function makeUser(): UserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
  }
}

function makeAssistant(): AssistantMessage {
  const usage: TokenUsage = { input_tokens: 10, output_tokens: 5 }
  return {
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage,
    },
  }
}

function makeProgress(): ProgressMessage {
  return {
    type: "progress",
    data: {
      type: "agent_progress",
      agentId: "agent-1",
      message: {
        type: "assistant",
        timestamp: "2025-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [],
        },
      },
    },
  } as unknown as ProgressMessage
}

function makeSystem(subtype = "init"): SystemMessage {
  return {
    type: "system",
    subtype,
    content: "system content",
  } as SystemMessage
}

function makeSummary(): SummaryMessage {
  return {
    type: "summary",
    summary: "Conversation compacted",
  } as SummaryMessage
}

const FIXTURES: Record<string, RawMessage> = {
  user: makeUser(),
  assistant: makeAssistant(),
  progress: makeProgress(),
  system: makeSystem(),
  summary: makeSummary(),
  compactBoundary: makeSystem("compact_boundary"),
  systemNoSubtype: makeSystem(""),
}

const GUARDS: Array<[string, (m: RawMessage) => boolean, string[]]> = [
  ["isUserMessage", isUserMessage, ["user"]],
  ["isAssistantMessage", isAssistantMessage, ["assistant"]],
  ["isProgressMessage", isProgressMessage, ["progress"]],
  ["isSystemMessage", isSystemMessage, ["system", "compactBoundary", "systemNoSubtype"]],
  ["isSummaryMessage", isSummaryMessage, ["summary"]],
  ["isCompactBoundary", isCompactBoundary, ["compactBoundary"]],
]

describe.each(GUARDS)("%s", (_name, guard, accepted) => {
  it.each(Object.keys(FIXTURES))("classifies %s", (fixture) => {
    expect(guard(FIXTURES[fixture])).toBe(accepted.includes(fixture))
  })
})
