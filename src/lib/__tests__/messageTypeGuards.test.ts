import { describe, it, expect } from "vitest"
import {
  isUserMessage,
  isAssistantMessage,
  isProgressMessage,
  isSystemMessage,
  isSummaryMessage,
  isCompactBoundary,
} from "@/lib/messageTypeGuards"
import type {
  UserMessage,
  AssistantMessage,
  ProgressMessage,
  SystemMessage,
  SummaryMessage,
  TokenUsage,
} from "@/lib/types"

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

// ── isUserMessage ────────────────────────────────────────────────────────────

describe("isUserMessage", () => {
  it("returns true for a user message", () => {
    expect(isUserMessage(makeUser())).toBe(true)
  })

  it("returns false for an assistant message", () => {
    expect(isUserMessage(makeAssistant())).toBe(false)
  })

  it("returns false for a progress message", () => {
    expect(isUserMessage(makeProgress())).toBe(false)
  })

  it("returns false for a system message", () => {
    expect(isUserMessage(makeSystem())).toBe(false)
  })

  it("returns false for a summary message", () => {
    expect(isUserMessage(makeSummary())).toBe(false)
  })
})

// ── isAssistantMessage ───────────────────────────────────────────────────────

describe("isAssistantMessage", () => {
  it("returns true for an assistant message", () => {
    expect(isAssistantMessage(makeAssistant())).toBe(true)
  })

  it("returns false for a user message", () => {
    expect(isAssistantMessage(makeUser())).toBe(false)
  })

  it("returns false for a progress message", () => {
    expect(isAssistantMessage(makeProgress())).toBe(false)
  })

  it("returns false for a system message", () => {
    expect(isAssistantMessage(makeSystem())).toBe(false)
  })

  it("returns false for a summary message", () => {
    expect(isAssistantMessage(makeSummary())).toBe(false)
  })
})

// ── isProgressMessage ────────────────────────────────────────────────────────

describe("isProgressMessage", () => {
  it("returns true for a progress message", () => {
    expect(isProgressMessage(makeProgress())).toBe(true)
  })

  it("returns false for a user message", () => {
    expect(isProgressMessage(makeUser())).toBe(false)
  })

  it("returns false for an assistant message", () => {
    expect(isProgressMessage(makeAssistant())).toBe(false)
  })

  it("returns false for a system message", () => {
    expect(isProgressMessage(makeSystem())).toBe(false)
  })

  it("returns false for a summary message", () => {
    expect(isProgressMessage(makeSummary())).toBe(false)
  })
})

// ── isSystemMessage ──────────────────────────────────────────────────────────

describe("isSystemMessage", () => {
  it("returns true for a system message", () => {
    expect(isSystemMessage(makeSystem())).toBe(true)
  })

  it("returns true for compact_boundary system message", () => {
    expect(isSystemMessage(makeSystem("compact_boundary"))).toBe(true)
  })

  it("returns false for a user message", () => {
    expect(isSystemMessage(makeUser())).toBe(false)
  })

  it("returns false for an assistant message", () => {
    expect(isSystemMessage(makeAssistant())).toBe(false)
  })

  it("returns false for a progress message", () => {
    expect(isSystemMessage(makeProgress())).toBe(false)
  })

  it("returns false for a summary message", () => {
    expect(isSystemMessage(makeSummary())).toBe(false)
  })
})

// ── isSummaryMessage ─────────────────────────────────────────────────────────

describe("isSummaryMessage", () => {
  it("returns true for a summary message", () => {
    expect(isSummaryMessage(makeSummary())).toBe(true)
  })

  it("returns false for a user message", () => {
    expect(isSummaryMessage(makeUser())).toBe(false)
  })

  it("returns false for an assistant message", () => {
    expect(isSummaryMessage(makeAssistant())).toBe(false)
  })

  it("returns false for a progress message", () => {
    expect(isSummaryMessage(makeProgress())).toBe(false)
  })

  it("returns false for a system message", () => {
    expect(isSummaryMessage(makeSystem())).toBe(false)
  })
})

// ── isCompactBoundary ────────────────────────────────────────────────────────

describe("isCompactBoundary", () => {
  it("returns true for a system message with subtype compact_boundary", () => {
    expect(isCompactBoundary(makeSystem("compact_boundary"))).toBe(true)
  })

  it("returns false for a system message with a different subtype", () => {
    expect(isCompactBoundary(makeSystem("init"))).toBe(false)
  })

  it("returns false for a system message with no subtype", () => {
    expect(isCompactBoundary(makeSystem(""))).toBe(false)
  })

  it("returns false for a user message", () => {
    expect(isCompactBoundary(makeUser())).toBe(false)
  })

  it("returns false for an assistant message", () => {
    expect(isCompactBoundary(makeAssistant())).toBe(false)
  })

  it("returns false for a summary message", () => {
    expect(isCompactBoundary(makeSummary())).toBe(false)
  })
})
