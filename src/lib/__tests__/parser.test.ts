import { describe, it, expect, beforeEach } from "vitest"
import {
  parseSession,
  parseSessionAppend,
  getUserMessageText,
  getUserMessageImages,
  getToolColor,
  detectPendingInteraction,
} from "@/lib/parser"
import type { ParsedSession, SubAgentMessage, TokenUsage } from "@/lib/types"
import {
  resetFixtureCounter,
  userMsg,
  toolResultMsg,
  assistantMsg,
  textAssistant,
  toolUseAssistant,
  turnDurationMsg,
  summaryMsg,
  agentProgressMsg,
  toJsonl,
  simpleSession,
  toolUseSession,
  thinkingSession,
  metadataSession,
  compactionSession,
  subAgentSession,
} from "@/__tests__/fixtures"

beforeEach(() => {
  resetFixtureCounter()
})

// ── parseSession ──────────────────────────────────────────────────────────

describe("parseSession", () => {
  it("parses a simple 1-turn session", () => {
    const session = parseSession(simpleSession())
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBe("Hello, how are you?")
    expect(session.turns[0].assistantText).toEqual([
      "I'm doing great! How can I help you today?",
    ])
    expect(session.turns[0].durationMs).toBe(1500)
  })

  it("returns empty turns for empty input", () => {
    const session = parseSession("")
    expect(session.turns).toHaveLength(0)
    expect(session.rawMessages).toHaveLength(0)
    expect(session.stats.turnCount).toBe(0)
  })

  it("skips malformed JSON lines gracefully", () => {
    const input = `{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1","timestamp":"t"}
not valid json
{"type":"assistant","message":{"model":"claude-opus-4-6-20250115","id":"a1","role":"assistant","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a1","timestamp":"t"}`
    const session = parseSession(input)
    expect(session.rawMessages).toHaveLength(2)
    expect(session.turns).toHaveLength(1)
  })

  it("skips blank lines", () => {
    const jsonl = simpleSession()
    const withBlanks = "\n\n" + jsonl.split("\n").join("\n\n") + "\n\n"
    const session = parseSession(withBlanks)
    expect(session.turns).toHaveLength(1)
  })

  it("parses a multi-turn session with tool use", () => {
    const session = parseSession(toolUseSession())
    expect(session.turns).toHaveLength(2)

    // First turn: user asks to read, assistant uses Read tool
    const t1 = session.turns[0]
    expect(t1.userMessage).toBe("Read the file src/main.ts")
    expect(t1.toolCalls).toHaveLength(1)
    expect(t1.toolCalls[0].name).toBe("Read")
    expect(t1.toolCalls[0].result).toBe('console.log("hello")')
    expect(t1.toolCalls[0].isError).toBe(false)

    // Second turn: user asks to edit
    const t2 = session.turns[1]
    expect(t2.userMessage).toBe("Now edit it")
    expect(t2.toolCalls).toHaveLength(1)
    expect(t2.toolCalls[0].name).toBe("Edit")
    expect(t2.toolCalls[0].result).toBe("File edited successfully")
  })

  it("parses a session with thinking blocks", () => {
    const session = parseSession(thinkingSession())
    expect(session.turns).toHaveLength(1)
    const turn = session.turns[0]
    expect(turn.thinking).toHaveLength(1)
    expect(turn.thinking[0].thinking).toBe(
      "Let me think about this step by step..."
    )
    expect(turn.assistantText).toEqual([
      "After careful analysis, here's the solution.",
    ])
  })

  it("extracts session metadata", () => {
    const session = parseSession(metadataSession())
    expect(session.sessionId).toBe("session-abc-123")
    expect(session.version).toBe("1.0.0")
    expect(session.gitBranch).toBe("main")
    expect(session.cwd).toBe("/home/user/project")
    expect(session.slug).toBe("my-project")
    expect(session.model).toBe("claude-opus-4-6-20250115")
  })

  it("handles session with no metadata gracefully", () => {
    const jsonl = toJsonl([
      userMsg("Hello"),
      textAssistant("Hi"),
    ])
    const session = parseSession(jsonl)
    // sessionId comes from message's sessionId field
    expect(session.version).toBe("")
    expect(session.gitBranch).toBe("")
    expect(session.cwd).toBe("")
    expect(session.slug).toBe("")
  })

  it("parses compaction / summary messages", () => {
    const session = parseSession(compactionSession())
    // There are 3 user messages but summary compacts the first 2 turns
    // The third turn should have compactionSummary
    expect(session.turns).toHaveLength(3)
    const lastTurn = session.turns[2]
    expect(lastTurn.compactionSummary).toBeDefined()
    expect(lastTurn.compactionSummary).toContain("Context compacted after 2 turns")
  })

  it("parses sub-agent progress messages", () => {
    const session = parseSession(subAgentSession())
    expect(session.turns).toHaveLength(1)
    const turn = session.turns[0]
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0].name).toBe("Task")
    expect(turn.subAgentActivity.length).toBeGreaterThan(0)
    expect(turn.subAgentActivity[0].agentId).toBe("agent-1")
  })

  it("creates a synthetic turn for assistant without preceding user message", () => {
    const jsonl = toJsonl([
      textAssistant("I'll start by helping you."),
    ])
    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBeNull()
    expect(session.turns[0].assistantText).toEqual([
      "I'll start by helping you.",
    ])
  })

  it("skips isMeta user messages (they don't start new turns)", () => {
    const jsonl = toJsonl([
      userMsg("Real message"),
      textAssistant("Response"),
      { ...userMsg("Meta message"), isMeta: true },
    ])
    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)
  })

  it("deduplicates token usage by message ID", () => {
    // Simulate Claude Code logging multiple content blocks for the same API call
    const msgId = "shared-msg-id"
    const jsonl = toJsonl([
      userMsg("Hello"),
      assistantMsg([{ type: "thinking", thinking: "thinking...", signature: "s" }], {
        message: {
          model: "claude-opus-4-6-20250115",
          id: msgId,
          role: "assistant",
          content: [{ type: "thinking", thinking: "thinking...", signature: "s" }],
          stop_reason: null,
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      }),
      assistantMsg([{ type: "text", text: "response" }], {
        message: {
          model: "claude-opus-4-6-20250115",
          id: msgId,
          role: "assistant",
          content: [{ type: "text", text: "response" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      }),
    ])
    const session = parseSession(jsonl)
    // Usage should be counted only once since both messages share the same ID
    expect(session.turns[0].tokenUsage?.input_tokens).toBe(1000)
    expect(session.turns[0].tokenUsage?.output_tokens).toBe(500)
  })

  it("merges token usage from different message IDs", () => {
    const jsonl = toJsonl([
      userMsg("Hello"),
      assistantMsg([{ type: "text", text: "step 1" }], {
        message: {
          model: "claude-opus-4-6-20250115",
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "step 1" }],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
      assistantMsg([{ type: "text", text: "step 2" }], {
        message: {
          model: "claude-opus-4-6-20250115",
          id: "msg-2",
          role: "assistant",
          content: [{ type: "text", text: "step 2" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      }),
    ])
    const session = parseSession(jsonl)
    expect(session.turns[0].tokenUsage?.input_tokens).toBe(300)
    expect(session.turns[0].tokenUsage?.output_tokens).toBe(150)
  })

  it("handles tool_result errors correctly", () => {
    const toolId = "err_tool"
    const jsonl = toJsonl([
      userMsg("Run something"),
      toolUseAssistant("Bash", { command: "exit 1" }, toolId),
      toolResultMsg(toolId, "Command failed with exit code 1", true),
      textAssistant("The command failed."),
    ])
    const session = parseSession(jsonl)
    expect(session.turns[0].toolCalls[0].isError).toBe(true)
    expect(session.turns[0].toolCalls[0].result).toBe(
      "Command failed with exit code 1"
    )
  })

  it("records turn duration from system messages", () => {
    const jsonl = toJsonl([
      userMsg("Hi"),
      textAssistant("Hello!"),
      turnDurationMsg(4200),
    ])
    const session = parseSession(jsonl)
    expect(session.turns[0].durationMs).toBe(4200)
  })

  it("handles tool_use then tool_result across user messages", () => {
    const toolId = "tool_abc"
    const jsonl = toJsonl([
      userMsg("Do it"),
      toolUseAssistant("Read", { file_path: "a.ts" }, toolId),
      toolResultMsg(toolId, "file contents here"),
      textAssistant("Got it"),
    ])
    const session = parseSession(jsonl)
    const tc = session.turns[0].toolCalls[0]
    expect(tc.name).toBe("Read")
    expect(tc.result).toBe("file contents here")
    expect(tc.isError).toBe(false)
  })

  it("preserves rawMessages", () => {
    const session = parseSession(simpleSession())
    expect(session.rawMessages.length).toBeGreaterThan(0)
    expect(session.rawMessages[0].type).toBe("user")
  })
})

// ── Content block ordering ──────────────────────────────────────────────

describe("content blocks", () => {
  it("creates thinking content blocks", () => {
    const session = parseSession(thinkingSession())
    const blocks = session.turns[0].contentBlocks
    const thinkingBlocks = blocks.filter((b) => b.kind === "thinking")
    expect(thinkingBlocks.length).toBeGreaterThan(0)
  })

  it("creates text content blocks", () => {
    const session = parseSession(simpleSession())
    const blocks = session.turns[0].contentBlocks
    const textBlocks = blocks.filter((b) => b.kind === "text")
    expect(textBlocks.length).toBeGreaterThan(0)
    expect(textBlocks[0].kind === "text" && textBlocks[0].text[0]).toBe(
      "I'm doing great! How can I help you today?"
    )
  })

  it("creates tool_calls content blocks", () => {
    const session = parseSession(toolUseSession())
    const blocks = session.turns[0].contentBlocks
    const toolBlocks = blocks.filter((b) => b.kind === "tool_calls")
    expect(toolBlocks.length).toBeGreaterThan(0)
  })

  it("creates sub_agent content blocks", () => {
    const session = parseSession(subAgentSession())
    const blocks = session.turns[0].contentBlocks
    const subAgentBlocks = blocks.filter((b) => b.kind === "sub_agent")
    expect(subAgentBlocks.length).toBeGreaterThan(0)
  })

  it("extracts inline <thinking> tags from text blocks", () => {
    const jsonl = toJsonl([
      userMsg("Think about it"),
      assistantMsg([{ type: "text", text: "<thinking>Deep thought</thinking>The answer is 42." }], {
        message: {
          model: "claude-opus-4-6-20250115",
          id: "inline-think",
          role: "assistant",
          content: [{ type: "text", text: "<thinking>Deep thought</thinking>The answer is 42." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ])
    const session = parseSession(jsonl)
    const turn = session.turns[0]
    expect(turn.thinking).toHaveLength(1)
    expect(turn.thinking[0].thinking).toBe("Deep thought")
    expect(turn.assistantText).toContain("The answer is 42.")
  })

  it("handles multiple inline <thinking> tags", () => {
    const text = "<thinking>First thought</thinking>Middle text<thinking>Second thought</thinking>End text"
    const jsonl = toJsonl([
      userMsg("Think twice"),
      assistantMsg([{ type: "text", text }], {
        message: {
          model: "claude-opus-4-6-20250115",
          id: "multi-think",
          role: "assistant",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ])
    const session = parseSession(jsonl)
    const turn = session.turns[0]
    expect(turn.thinking).toHaveLength(2)
    expect(turn.thinking[0].thinking).toBe("First thought")
    expect(turn.thinking[1].thinking).toBe("Second thought")
  })

  it("merges consecutive thinking blocks into one content block", () => {
    // When assistant message has thinking then text then another thinking in a separate message,
    // consecutive thinking blocks should merge
    const jsonl = toJsonl([
      userMsg("Complex"),
      assistantMsg(
        [
          { type: "thinking", thinking: "thought A", signature: "s1" },
          { type: "thinking", thinking: "thought B", signature: "s2" },
          { type: "text", text: "result" },
        ],
        {
          message: {
            model: "claude-opus-4-6-20250115",
            id: "merge-think",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "thought A", signature: "s1" },
              { type: "thinking", thinking: "thought B", signature: "s2" },
              { type: "text", text: "result" },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }
      ),
    ])
    const session = parseSession(jsonl)
    const thinkingCBs = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "thinking"
    )
    // Both thinking blocks should be merged into one content block
    expect(thinkingCBs).toHaveLength(1)
    if (thinkingCBs[0].kind === "thinking") {
      expect(thinkingCBs[0].blocks).toHaveLength(2)
    }
  })

  it("merges consecutive text blocks across assistant messages into one content block", () => {
    const jsonl = toJsonl([
      userMsg("Hello"),
      assistantMsg([{ type: "text", text: "Part 1" }], {
        message: {
          model: "claude-opus-4-6-20250115",
          id: "text-merge-1",
          role: "assistant",
          content: [{ type: "text", text: "Part 1" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      assistantMsg([{ type: "text", text: "Part 2" }], {
        message: {
          model: "claude-opus-4-6-20250115",
          id: "text-merge-2",
          role: "assistant",
          content: [{ type: "text", text: "Part 2" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ])
    const session = parseSession(jsonl)
    const textCBs = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "text"
    )
    // Both text blocks should be merged into one content block
    expect(textCBs).toHaveLength(1)
    if (textCBs[0].kind === "text") {
      expect(textCBs[0].text).toEqual(["Part 1", "Part 2"])
    }
  })
})

// ── Metadata extraction ─────────────────────────────────────────────────

describe("metadata extraction", () => {
  it("extracts first available metadata values", () => {
    const jsonl = toJsonl([
      userMsg("First", {
        sessionId: "s1",
        version: "1.0",
        gitBranch: "feat",
        cwd: "/project",
        slug: "slug-1",
      }),
      userMsg("Second", {
        sessionId: "s2",
        version: "2.0",
        gitBranch: "main",
        cwd: "/other",
        slug: "slug-2",
      }),
      textAssistant("ok"),
    ])
    const session = parseSession(jsonl)
    // First values should win
    expect(session.sessionId).toBe("s1")
    expect(session.version).toBe("1.0")
    expect(session.gitBranch).toBe("feat")
    expect(session.cwd).toBe("/project")
    expect(session.slug).toBe("slug-1")
  })

  it("extracts model from assistant message", () => {
    const jsonl = toJsonl([
      userMsg("Hi"),
      assistantMsg([{ type: "text", text: "Hey" }], {
        message: {
          model: "claude-sonnet-4-5-20250115",
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "Hey" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ])
    const session = parseSession(jsonl)
    expect(session.model).toBe("claude-sonnet-4-5-20250115")
  })
})

// ── computeStats ────────────────────────────────────────────────────────

describe("stats computation", () => {
  it("computes basic token stats", () => {
    const session = parseSession(simpleSession())
    const { stats } = session
    expect(stats.turnCount).toBe(1)
    expect(stats.totalInputTokens).toBe(1000)
    expect(stats.totalOutputTokens).toBe(500)
    expect(stats.totalCacheCreationTokens).toBe(200)
    expect(stats.totalCacheReadTokens).toBe(100)
    expect(stats.totalDurationMs).toBe(1500)
  })

  it("accumulates stats across multiple turns", () => {
    const session = parseSession(toolUseSession())
    const { stats } = session
    expect(stats.turnCount).toBe(2)
    expect(stats.totalDurationMs).toBe(3000) // 2000 + 1000
  })

  it("counts tool calls by name", () => {
    const session = parseSession(toolUseSession())
    const { stats } = session
    expect(stats.toolCallCounts["Read"]).toBe(1)
    expect(stats.toolCallCounts["Edit"]).toBe(1)
  })

  it("counts tool errors", () => {
    const toolId = "err_t"
    const jsonl = toJsonl([
      userMsg("Run"),
      toolUseAssistant("Bash", { command: "fail" }, toolId),
      toolResultMsg(toolId, "error", true),
      textAssistant("It failed"),
    ])
    const session = parseSession(jsonl)
    expect(session.stats.errorCount).toBe(1)
  })

  it("returns zero stats for empty session", () => {
    const session = parseSession("")
    expect(session.stats.turnCount).toBe(0)
    expect(session.stats.totalInputTokens).toBe(0)
    expect(session.stats.totalOutputTokens).toBe(0)
    expect(session.stats.totalCostUSD).toBe(0)
    expect(session.stats.errorCount).toBe(0)
  })

  it("computes cost based on model pricing", () => {
    const session = parseSession(simpleSession())
    expect(session.stats.totalCostUSD).toBeGreaterThan(0)
  })

  it("includes sub-agent tool calls and tokens in stats", () => {
    const session = parseSession(subAgentSession())
    expect(session.stats.toolCallCounts["Task"]).toBe(1)
    // Sub-agent uses WebSearch
    expect(session.stats.toolCallCounts["WebSearch"]).toBe(1)
    // Sub-agent tokens should be included
    expect(session.stats.totalInputTokens).toBeGreaterThan(0)
  })
})

// ── buildCompactionSummary ──────────────────────────────────────────────

describe("compaction summary", () => {
  it("attaches compaction summary to the turn after the summary message", () => {
    const session = parseSession(compactionSession())
    // First two turns should NOT have compaction
    expect(session.turns[0].compactionSummary).toBeUndefined()
    expect(session.turns[1].compactionSummary).toBeUndefined()
    // Third turn (after summary) should have compaction
    const third = session.turns[2]
    expect(third.compactionSummary).toBeDefined()
  })

  it("includes turn count in compaction summary", () => {
    const session = parseSession(compactionSession())
    const summary = session.turns[2].compactionSummary!
    expect(summary).toContain("2 turns compacted")
  })

  it("includes tool usage in compaction summary when tools are used", () => {
    const toolId = "ct1"
    const jsonl = toJsonl([
      userMsg("Read file"),
      toolUseAssistant("Read", { file_path: "a.ts" }, toolId),
      toolResultMsg(toolId, "content"),
      textAssistant("Done"),
      turnDurationMsg(1000),
      summaryMsg("Compacted"),
      userMsg("Next"),
      textAssistant("After compaction"),
    ])
    const session = parseSession(jsonl)
    const lastTurn = session.turns[session.turns.length - 1]
    expect(lastTurn.compactionSummary).toContain("Read x1")
  })

  it("includes user prompts in compaction summary", () => {
    const session = parseSession(compactionSession())
    const summary = session.turns[2].compactionSummary!
    expect(summary).toContain("Prompts:")
    expect(summary).toContain("First message")
  })

  it("returns just title for empty turns before summary", () => {
    const jsonl = toJsonl([
      summaryMsg("Empty compaction"),
      userMsg("After"),
      textAssistant("Response"),
    ])
    const session = parseSession(jsonl)
    const turn = session.turns[0]
    expect(turn.compactionSummary).toBe("Empty compaction")
  })

  it("truncates long user prompts in compaction summary to 120 chars", () => {
    const longMsg = "A".repeat(200)
    const jsonl = toJsonl([
      userMsg(longMsg),
      textAssistant("Short response"),
      turnDurationMsg(500),
      summaryMsg("Long prompt test"),
      userMsg("After"),
      textAssistant("ok"),
    ])
    const session = parseSession(jsonl)
    const summary = session.turns[1].compactionSummary!
    // Should truncate to 117 chars + "..."
    expect(summary).toContain("...")
  })

  it("limits displayed prompts to 6 and notes extras", () => {
    const messages: Array<Record<string, unknown>> = []
    for (let i = 0; i < 8; i++) {
      messages.push(userMsg(`Prompt ${i}`))
      messages.push(textAssistant(`Response ${i}`))
      messages.push(turnDurationMsg(100))
    }
    messages.push(summaryMsg("Many prompts"))
    messages.push(userMsg("After"))
    messages.push(textAssistant("ok"))

    const session = parseSession(toJsonl(messages))
    const lastTurn = session.turns[session.turns.length - 1]
    const summary = lastTurn.compactionSummary!
    expect(summary).toContain("...and 2 more")
  })
})

// ── parseSessionAppend ──────────────────────────────────────────────────

describe("parseSessionAppend", () => {
  it("appends new messages to an existing session", () => {
    const existing = parseSession(simpleSession())
    expect(existing.turns).toHaveLength(1)

    resetFixtureCounter()
    const newJsonl = toJsonl([
      userMsg("Follow up question"),
      textAssistant("Follow up answer"),
      turnDurationMsg(800),
    ])

    const updated = parseSessionAppend(existing, newJsonl)
    expect(updated.turns).toHaveLength(2)
    expect(updated.turns[1].userMessage).toBe("Follow up question")
  })

  it("returns existing session when new text is empty", () => {
    const existing = parseSession(simpleSession())
    const same = parseSessionAppend(existing, "")
    expect(same).toBe(existing) // same reference
  })

  it("returns existing session when new text has only blank lines", () => {
    const existing = parseSession(simpleSession())
    const same = parseSessionAppend(existing, "\n  \n  \n")
    expect(same).toBe(existing)
  })

  it("re-parses the last turn to capture new tool results", () => {
    const toolId = "append_tool"
    const firstPart = toJsonl([
      userMsg("Do something"),
      toolUseAssistant("Read", { file_path: "test.ts" }, toolId),
    ])
    const existing = parseSession(firstPart)
    // Tool call should be pending (no result yet)
    expect(existing.turns[0].toolCalls[0].result).toBeNull()

    const newPart = toJsonl([
      toolResultMsg(toolId, "file contents"),
      textAssistant("Here's the file."),
      turnDurationMsg(1200),
    ])

    const updated = parseSessionAppend(existing, newPart)
    expect(updated.turns).toHaveLength(1)
    expect(updated.turns[0].toolCalls[0].result).toBe("file contents")
    expect(updated.turns[0].durationMs).toBe(1200)
  })

  it("rebuilds from earlier turn when late sub-agent progress references it", () => {
    const taskToolId = "task_late"
    const firstPart = toJsonl([
      userMsg("Use agent"),
      toolUseAssistant("Task", { prompt: "Research" }, taskToolId),
      toolResultMsg(taskToolId, "Done"),
      textAssistant("Agent finished."),
      turnDurationMsg(2000),
      userMsg("Follow up"),
      textAssistant("Sure"),
      turnDurationMsg(500),
    ])
    const existing = parseSession(firstPart)
    expect(existing.turns).toHaveLength(2)

    // Late sub-agent progress arrives referencing the first turn's tool call
    const newPart = toJsonl([
      agentProgressMsg("agent-late", taskToolId, "assistant", [
        { type: "text", text: "Late progress from agent" },
      ]),
    ])

    const updated = parseSessionAppend(existing, newPart)
    // The rebuild starts from turn 0 (since it owns the referenced tool call),
    // but the progress message appears chronologically after turn 1's user message,
    // so buildTurns attaches it to the current turn at that point (turn 1).
    // The key thing is that both turns are rebuilt and rawMessages accumulate correctly.
    expect(updated.turns).toHaveLength(2)
    expect(updated.rawMessages.length).toBe(
      existing.rawMessages.length + 1
    )
    // The late progress ends up on the last turn since it arrives after turn 1 starts
    const lastTurn = updated.turns[updated.turns.length - 1]
    expect(lastTurn.subAgentActivity.length).toBeGreaterThan(0)
    expect(lastTurn.subAgentActivity.some(
      (m) => m.text.includes("Late progress from agent")
    )).toBe(true)
  })

  it("preserves metadata from existing session", () => {
    const existing = parseSession(metadataSession())
    const newJsonl = toJsonl([
      userMsg("Follow up"),
      textAssistant("Sure"),
    ])
    const updated = parseSessionAppend(existing, newJsonl)
    expect(updated.sessionId).toBe("session-abc-123")
    expect(updated.version).toBe("1.0.0")
    expect(updated.gitBranch).toBe("main")
    expect(updated.cwd).toBe("/home/user/project")
    expect(updated.slug).toBe("my-project")
  })

  it("accumulates rawMessages", () => {
    const existing = parseSession(simpleSession())
    const origCount = existing.rawMessages.length
    const newJsonl = toJsonl([
      userMsg("More"),
      textAssistant("More back"),
    ])
    const updated = parseSessionAppend(existing, newJsonl)
    expect(updated.rawMessages.length).toBe(origCount + 2)
  })

  it("recomputes stats after appending", () => {
    const existing = parseSession(simpleSession())
    const newJsonl = toJsonl([
      userMsg("Second turn"),
      textAssistant("Another answer"),
      turnDurationMsg(2000),
    ])
    const updated = parseSessionAppend(existing, newJsonl)
    expect(updated.stats.turnCount).toBe(2)
    expect(updated.stats.totalDurationMs).toBe(3500) // 1500 + 2000
  })
})

// ── getUserMessageText ──────────────────────────────────────────────────

describe("getUserMessageText", () => {
  it("returns empty string for null content", () => {
    expect(getUserMessageText(null)).toBe("")
  })

  it("returns the string as-is for string content", () => {
    expect(getUserMessageText("Hello world")).toBe("Hello world")
  })

  it("extracts text from content blocks", () => {
    const content = [
      { type: "text" as const, text: "Part one" },
      { type: "text" as const, text: "Part two" },
    ]
    expect(getUserMessageText(content)).toBe("Part one\nPart two")
  })

  it("ignores non-text blocks", () => {
    const content = [
      { type: "text" as const, text: "Hello" },
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: "abc" },
      },
      { type: "text" as const, text: "World" },
    ]
    expect(getUserMessageText(content)).toBe("Hello\nWorld")
  })

  it("returns empty string for empty array", () => {
    expect(getUserMessageText([])).toBe("")
  })

  it("returns empty string for array with no text blocks", () => {
    const content = [
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: "abc" },
      },
    ]
    expect(getUserMessageText(content)).toBe("")
  })
})

// ── getUserMessageImages ────────────────────────────────────────────────

describe("getUserMessageImages", () => {
  it("returns empty array for null", () => {
    expect(getUserMessageImages(null)).toEqual([])
  })

  it("returns empty array for string content", () => {
    expect(getUserMessageImages("hello")).toEqual([])
  })

  it("returns empty array when no image blocks present", () => {
    const content = [{ type: "text" as const, text: "Hello" }]
    expect(getUserMessageImages(content)).toEqual([])
  })

  it("extracts image blocks from content", () => {
    const imageBlock = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png", data: "abc123" },
    }
    const content = [
      { type: "text" as const, text: "Here's an image:" },
      imageBlock,
    ]
    const images = getUserMessageImages(content)
    expect(images).toHaveLength(1)
    expect(images[0].source.data).toBe("abc123")
  })

  it("extracts multiple image blocks", () => {
    const content = [
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: "img1" },
      },
      { type: "text" as const, text: "between" },
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/jpeg", data: "img2" },
      },
    ]
    const images = getUserMessageImages(content)
    expect(images).toHaveLength(2)
    expect(images[0].source.data).toBe("img1")
    expect(images[1].source.data).toBe("img2")
  })
})

// ── getToolColor ────────────────────────────────────────────────────────

describe("getToolColor", () => {
  it("returns correct color for Read tool", () => {
    expect(getToolColor("Read")).toBe("text-blue-400")
  })

  it("returns correct color for Write tool", () => {
    expect(getToolColor("Write")).toBe("text-green-400")
  })

  it("returns correct color for Edit tool", () => {
    expect(getToolColor("Edit")).toBe("text-amber-400")
  })

  it("returns correct color for Bash tool", () => {
    expect(getToolColor("Bash")).toBe("text-red-400")
  })

  it("returns correct color for Grep tool", () => {
    expect(getToolColor("Grep")).toBe("text-purple-400")
  })

  it("returns correct color for Glob tool", () => {
    expect(getToolColor("Glob")).toBe("text-cyan-400")
  })

  it("returns correct color for Task tool", () => {
    expect(getToolColor("Task")).toBe("text-indigo-400")
  })

  it("returns correct color for WebFetch tool", () => {
    expect(getToolColor("WebFetch")).toBe("text-orange-400")
  })

  it("returns correct color for WebSearch tool", () => {
    expect(getToolColor("WebSearch")).toBe("text-orange-400")
  })

  it("returns correct color for AskUserQuestion tool", () => {
    expect(getToolColor("AskUserQuestion")).toBe("text-pink-400")
  })

  it("returns default color for unknown tools", () => {
    expect(getToolColor("UnknownTool")).toBe("text-slate-400")
  })

  it("returns default color for empty string", () => {
    expect(getToolColor("")).toBe("text-slate-400")
  })
})

// ── detectPendingInteraction ────────────────────────────────────────────

describe("detectPendingInteraction", () => {
  function makeSessionWithLastToolCall(
    name: string,
    input: Record<string, unknown>,
    result: string | null = null,
    isError = false
  ): ParsedSession {
    return {
      sessionId: "test",
      version: "",
      gitBranch: "",
      cwd: "",
      slug: "",
      model: "",
      turns: [
        {
          id: "t1",
          userMessage: "test",
          contentBlocks: [],
          thinking: [],
          assistantText: [],
          toolCalls: [
            {
              id: "tc1",
              name,
              input,
              result,
              isError,
              timestamp: "",
            },
          ],
          subAgentActivity: [],
          timestamp: "",
          durationMs: null,
          tokenUsage: null,
          model: null,
        },
      ],
      stats: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalCostUSD: 0,
        toolCallCounts: {},
        errorCount: 0,
        totalDurationMs: 0,
        turnCount: 1,
      },
      rawMessages: [],
    }
  }

  it("returns null for empty session", () => {
    const session: ParsedSession = {
      sessionId: "",
      version: "",
      gitBranch: "",
      cwd: "",
      slug: "",
      model: "",
      turns: [],
      stats: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalCostUSD: 0,
        toolCallCounts: {},
        errorCount: 0,
        totalDurationMs: 0,
        turnCount: 0,
      },
      rawMessages: [],
    }
    expect(detectPendingInteraction(session)).toBeNull()
  })

  it("returns null when last turn has no tool calls", () => {
    const session = makeSessionWithLastToolCall("Read", {})
    session.turns[0].toolCalls = []
    expect(detectPendingInteraction(session)).toBeNull()
  })

  it("returns null for non-interactive tools", () => {
    const session = makeSessionWithLastToolCall("Read", { file_path: "a.ts" })
    expect(detectPendingInteraction(session)).toBeNull()
  })

  it("detects ExitPlanMode as plan pending interaction", () => {
    const session = makeSessionWithLastToolCall(
      "ExitPlanMode",
      { allowedPrompts: [{ tool: "Bash", prompt: "Run tests?" }] },
      "Plan approval pending",
      true
    )
    const result = detectPendingInteraction(session)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("plan")
    if (result!.type === "plan") {
      expect(result!.allowedPrompts).toHaveLength(1)
      expect(result!.allowedPrompts![0].tool).toBe("Bash")
    }
  })

  it("detects AskUserQuestion as question pending interaction", () => {
    const session = makeSessionWithLastToolCall(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Which option?",
            options: [
              { label: "A" },
              { label: "B" },
            ],
          },
        ],
      },
      "Answer questions?",
      true
    )
    const result = detectPendingInteraction(session)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("question")
    if (result!.type === "question") {
      expect(result!.questions).toHaveLength(1)
      expect(result!.questions[0].question).toBe("Which option?")
      expect(result!.questions[0].options).toHaveLength(2)
    }
  })

  it("returns null for ExitPlanMode when user already responded (non-error result)", () => {
    const session = makeSessionWithLastToolCall(
      "ExitPlanMode",
      {},
      "Plan approved",
      false
    )
    expect(detectPendingInteraction(session)).toBeNull()
  })

  it("returns null for AskUserQuestion when user already responded", () => {
    const session = makeSessionWithLastToolCall(
      "AskUserQuestion",
      { questions: [{ question: "Q?", options: [{ label: "A" }] }] },
      "User selected A",
      false
    )
    expect(detectPendingInteraction(session)).toBeNull()
  })

  it("returns null for AskUserQuestion with empty questions array", () => {
    const session = makeSessionWithLastToolCall(
      "AskUserQuestion",
      { questions: [] },
      null,
      false
    )
    expect(detectPendingInteraction(session)).toBeNull()
  })

  it("returns null for AskUserQuestion with no questions field", () => {
    const session = makeSessionWithLastToolCall(
      "AskUserQuestion",
      {},
      null,
      false
    )
    expect(detectPendingInteraction(session)).toBeNull()
  })

  it("detects pending ExitPlanMode with null result", () => {
    const session = makeSessionWithLastToolCall(
      "ExitPlanMode",
      {},
      null,
      false
    )
    const result = detectPendingInteraction(session)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("plan")
  })

  // Helper for multi-turn loop detection tests
  function makeMultiTurnSession(...turnDefs: Array<{ id: string; tool: string; result: string | null; isError: boolean }>): ParsedSession {
    return {
      sessionId: "test",
      version: "",
      gitBranch: "",
      cwd: "",
      slug: "",
      model: "",
      turns: turnDefs.map((t) => ({
        id: t.id,
        userMessage: "yes" as string | null | (string | { type: string })[],
        contentBlocks: [] as { type: string; text?: string }[],
        thinking: [] as { text: string; isSummary?: boolean }[],
        assistantText: [] as string[],
        toolCalls: [
          { id: `tc_${t.id}`, name: t.tool, input: {}, result: t.result, isError: t.isError, timestamp: "" },
        ],
        subAgentActivity: [] as SubAgentMessage[],
        timestamp: "",
        durationMs: null as number | null,
        tokenUsage: null as TokenUsage | null,
        model: null as string | null,
      })),
      stats: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalCostUSD: 0,
        toolCallCounts: {},
        errorCount: 0,
        totalDurationMs: 0,
        turnCount: turnDefs.length,
      },
      rawMessages: [],
    }
  }

  it("returns null when ExitPlanMode loops (previous turn also had pending ExitPlanMode)", () => {
    const session = makeMultiTurnSession(
      { id: "t1", tool: "ExitPlanMode", result: "Plan approval pending", isError: true },
      { id: "t2", tool: "ExitPlanMode", result: "Plan approval pending", isError: true },
    )
    expect(detectPendingInteraction(session)).toBeNull()
  })

  it("detects ExitPlanMode when previous turn had a different tool (not a loop)", () => {
    const session = makeMultiTurnSession(
      { id: "t1", tool: "Read", result: "file contents", isError: false },
      { id: "t2", tool: "ExitPlanMode", result: "Plan approval pending", isError: true },
    )
    const result = detectPendingInteraction(session)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("plan")
  })

  it("returns null when AskUserQuestion loops (previous turn also had pending AskUserQuestion)", () => {
    const session = makeMultiTurnSession(
      { id: "t1", tool: "AskUserQuestion", result: "Answer questions?", isError: true },
      { id: "t2", tool: "AskUserQuestion", result: "Answer questions?", isError: true },
    )
    expect(detectPendingInteraction(session)).toBeNull()
  })
})

// ── Sub-agent parsing ───────────────────────────────────────────────────

describe("sub-agent progress parsing", () => {
  it("extracts sub-agent text messages", () => {
    const session = parseSession(subAgentSession())
    const subMsgs = session.turns[0].subAgentActivity
    const textMsgs = subMsgs.filter((m) => m.text.length > 0)
    expect(textMsgs.length).toBeGreaterThan(0)
    expect(textMsgs[0].text[0]).toBe("Researching...")
  })

  it("extracts sub-agent tool calls", () => {
    const session = parseSession(subAgentSession())
    const subMsgs = session.turns[0].subAgentActivity
    const withTools = subMsgs.filter((m) => m.toolCalls.length > 0)
    expect(withTools.length).toBeGreaterThan(0)
    expect(withTools[0].toolCalls[0].name).toBe("WebSearch")
  })

  it("extracts sub-agent thinking blocks", () => {
    const taskToolId = "task_think"
    const jsonl = toJsonl([
      userMsg("Think deep"),
      toolUseAssistant("Task", { prompt: "Deep thinking" }, taskToolId),
      agentProgressMsg("agent-t", taskToolId, "assistant", [
        { type: "thinking", thinking: "Agent is thinking...", signature: "" },
        { type: "text", text: "Agent conclusion" },
      ]),
      toolResultMsg(taskToolId, "Done"),
      textAssistant("Complete"),
    ])
    const session = parseSession(jsonl)
    const subMsgs = session.turns[0].subAgentActivity
    expect(subMsgs).toHaveLength(1)
    expect(subMsgs[0].thinking).toContain("Agent is thinking...")
    expect(subMsgs[0].text).toContain("Agent conclusion")
  })

  it("tracks sub-agent token usage", () => {
    const session = parseSession(subAgentSession())
    const subMsgs = session.turns[0].subAgentActivity
    const withUsage = subMsgs.filter((m) => m.tokenUsage !== null)
    expect(withUsage.length).toBeGreaterThan(0)
  })

  it("handles sub-agent tool result matching when not yet flushed", () => {
    // Sub-agent messages get flushed to the turn immediately on each progress event.
    // When the user-type progress message arrives with a tool_result, it looks up
    // subAgentMap which was already cleared by the flush. So tool results only match
    // if they arrive before the flush (i.e., in the same batch).
    // This test verifies the structure of sub-agent messages with tool calls.
    const taskToolId = "task_result"
    const subToolId = "sub_read_1"
    const jsonl = toJsonl([
      userMsg("Read via agent"),
      toolUseAssistant("Task", { prompt: "Read file" }, taskToolId),
      agentProgressMsg("agent-r", taskToolId, "assistant", [
        { type: "tool_use", id: subToolId, name: "Read", input: { file_path: "test.ts" } },
      ]),
      agentProgressMsg("agent-r", taskToolId, "user", [
        { type: "tool_result", tool_use_id: subToolId, content: "file contents here", is_error: false },
      ]),
      toolResultMsg(taskToolId, "Done"),
      textAssistant("Got it"),
    ])
    const session = parseSession(jsonl)
    const subMsgs = session.turns[0].subAgentActivity
    const withTools = subMsgs.filter((m) => m.toolCalls.length > 0)
    expect(withTools.length).toBeGreaterThan(0)
    const tc = withTools[0].toolCalls[0]
    expect(tc.name).toBe("Read")
    // Tool result is null because the sub-agent assistant message was flushed
    // before the user-type tool_result progress message arrived
    expect(tc.result).toBeNull()
  })

  it("records sub-agent model info", () => {
    const session = parseSession(subAgentSession())
    const assistantMsgs = session.turns[0].subAgentActivity.filter(
      (m) => m.model !== null
    )
    expect(assistantMsgs.length).toBeGreaterThan(0)
    expect(assistantMsgs[0].model).toBe("claude-sonnet-4-5-20250115")
  })

  it("extracts agentName and subagentType from Task tool call input", () => {
    const session = parseSession(subAgentSession())
    const subMsgs = session.turns[0].subAgentActivity
    expect(subMsgs.length).toBeGreaterThan(0)
    expect(subMsgs[0].agentName).toBe("researcher")
    expect(subMsgs[0].subagentType).toBe("Explore")
  })

  it("sets agentName and subagentType to null when Task input lacks them", () => {
    const taskToolId = "task_no_meta"
    const jsonl = toJsonl([
      userMsg("Do something"),
      toolUseAssistant("Task", { prompt: "Just do it" }, taskToolId),
      agentProgressMsg("agent-x", taskToolId, "assistant", [
        { type: "text", text: "Working..." },
      ]),
      toolResultMsg(taskToolId, "Done"),
      textAssistant("Finished"),
    ])
    const session = parseSession(jsonl)
    const subMsgs = session.turns[0].subAgentActivity
    expect(subMsgs.length).toBeGreaterThan(0)
    expect(subMsgs[0].agentName).toBeNull()
    expect(subMsgs[0].subagentType).toBeNull()
  })
})

// ── Edge cases ──────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles multiple tool calls in a single assistant message", () => {
    const jsonl = toJsonl([
      userMsg("Read two files"),
      assistantMsg(
        [
          { type: "tool_use", id: "multi_1", name: "Read", input: { file_path: "a.ts" } },
          { type: "tool_use", id: "multi_2", name: "Read", input: { file_path: "b.ts" } },
        ],
        {
          message: {
            model: "claude-opus-4-6-20250115",
            id: "multi-tool-msg",
            role: "assistant",
            content: [
              { type: "tool_use", id: "multi_1", name: "Read", input: { file_path: "a.ts" } },
              { type: "tool_use", id: "multi_2", name: "Read", input: { file_path: "b.ts" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }
      ),
      toolResultMsg("multi_1", "contents of a"),
      toolResultMsg("multi_2", "contents of b"),
      textAssistant("Read both files."),
    ])
    const session = parseSession(jsonl)
    expect(session.turns[0].toolCalls).toHaveLength(2)
    expect(session.turns[0].toolCalls[0].result).toBe("contents of a")
    expect(session.turns[0].toolCalls[1].result).toBe("contents of b")
  })

  it("handles text before and after tool calls in same message", () => {
    const jsonl = toJsonl([
      userMsg("Do stuff"),
      assistantMsg(
        [
          { type: "text", text: "Let me read the file." },
          { type: "tool_use", id: "mid_tool", name: "Read", input: { file_path: "x.ts" } },
        ],
        {
          message: {
            model: "claude-opus-4-6-20250115",
            id: "text-tool-msg",
            role: "assistant",
            content: [
              { type: "text", text: "Let me read the file." },
              { type: "tool_use", id: "mid_tool", name: "Read", input: { file_path: "x.ts" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }
      ),
      toolResultMsg("mid_tool", "file data"),
      textAssistant("Done reading."),
    ])
    const session = parseSession(jsonl)
    const turn = session.turns[0]
    expect(turn.assistantText).toContain("Let me read the file.")
    expect(turn.assistantText).toContain("Done reading.")
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0].result).toBe("file data")
  })

  it("handles only whitespace JSONL", () => {
    const session = parseSession("   \n  \n   ")
    expect(session.turns).toHaveLength(0)
  })

  it("handles a session with only system messages (no turns)", () => {
    const jsonl = toJsonl([
      turnDurationMsg(1000),
    ])
    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(0)
  })

  it("handles tool_result with complex content (array of blocks)", () => {
    const toolId = "complex_result"
    const jsonl = toJsonl([
      userMsg("Read"),
      toolUseAssistant("Read", { file_path: "test.ts" }, toolId),
      // tool_result with array content
      userMsg([
        {
          type: "tool_result",
          tool_use_id: toolId,
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
          is_error: false,
        },
      ] as unknown as string),
      textAssistant("Got it"),
    ])
    const session = parseSession(jsonl)
    expect(session.turns[0].toolCalls[0].result).toBe("line 1\nline 2")
  })

  it("handles summary message at the very start", () => {
    const jsonl = toJsonl([
      summaryMsg("Pre-existing compaction"),
      userMsg("After compaction"),
      textAssistant("Response"),
    ])
    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].compactionSummary).toBe("Pre-existing compaction")
  })

  it("assigns timestamp from user message to the turn", () => {
    const jsonl = toJsonl([
      userMsg("Test", { timestamp: "2025-06-15T12:30:00Z" }),
      textAssistant("ok"),
    ])
    const session = parseSession(jsonl)
    expect(session.turns[0].timestamp).toBe("2025-06-15T12:30:00Z")
  })

  it("preserves content block ordering: thinking -> text -> tool -> text", () => {
    const jsonl = toJsonl([
      userMsg("Complex multi-step"),
      assistantMsg(
        [
          { type: "thinking", thinking: "Let me plan this", signature: "s1" },
          { type: "text", text: "I'll help you." },
          { type: "tool_use", id: "order_t1", name: "Read", input: { file_path: "a.ts" } },
        ],
        {
          message: {
            model: "claude-opus-4-6-20250115",
            id: "order-msg-1",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Let me plan this", signature: "s1" },
              { type: "text", text: "I'll help you." },
              { type: "tool_use", id: "order_t1", name: "Read", input: { file_path: "a.ts" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }
      ),
      toolResultMsg("order_t1", "file data"),
      assistantMsg(
        [{ type: "text", text: "Here's the result." }],
        {
          message: {
            model: "claude-opus-4-6-20250115",
            id: "order-msg-2",
            role: "assistant",
            content: [{ type: "text", text: "Here's the result." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }
      ),
    ])
    const session = parseSession(jsonl)
    const blocks = session.turns[0].contentBlocks
    const kinds = blocks.map((b) => b.kind)
    expect(kinds).toEqual(["thinking", "text", "tool_calls", "text"])
  })

  it("handles only-tool-use assistant message (no text)", () => {
    const toolId = "only_tool"
    const jsonl = toJsonl([
      userMsg("Read it"),
      assistantMsg(
        [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: "z.ts" } }],
        {
          message: {
            model: "claude-opus-4-6-20250115",
            id: "tool-only",
            role: "assistant",
            content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: "z.ts" } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }
      ),
      toolResultMsg(toolId, "contents"),
      textAssistant("Done"),
    ])
    const session = parseSession(jsonl)
    expect(session.turns[0].assistantText).toContain("Done")
    expect(session.turns[0].toolCalls).toHaveLength(1)
    // First content block should be tool_calls, not text
    expect(session.turns[0].contentBlocks[0].kind).toBe("tool_calls")
  })

  it("assigns timestamp from assistant message for synthetic turns", () => {
    const jsonl = toJsonl([
      assistantMsg([{ type: "text", text: "Unsolicited" }], {
        timestamp: "2025-06-15T14:00:00Z",
        message: {
          model: "claude-opus-4-6-20250115",
          id: "synth-ts",
          role: "assistant",
          content: [{ type: "text", text: "Unsolicited" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ])
    const session = parseSession(jsonl)
    expect(session.turns[0].timestamp).toBe("2025-06-15T14:00:00Z")
  })
})

// ── branchedFrom metadata ────────────────────────────────────────────────

describe("branchedFrom metadata", () => {
  it("extracts branchedFrom from first-line metadata", () => {
    const branchedFrom = { sessionId: "original-123", turnIndex: 2 }
    const jsonl = toJsonl([
      userMsg("Hello", {
        sessionId: "branched-456",
        branchedFrom,
      } as Record<string, unknown>),
      textAssistant("Hi"),
    ])
    const session = parseSession(jsonl)
    expect(session.branchedFrom).toEqual(branchedFrom)
    expect(session.sessionId).toBe("branched-456")
  })

  it("returns undefined branchedFrom when not present", () => {
    const session = parseSession(simpleSession())
    expect(session.branchedFrom).toBeUndefined()
  })

  it("preserves branchedFrom in parseSessionAppend", () => {
    const branchedFrom = { sessionId: "parent-abc", turnIndex: null }
    const jsonl = toJsonl([
      userMsg("Hello", {
        sessionId: "branch-def",
        branchedFrom,
      } as Record<string, unknown>),
      textAssistant("Hi"),
    ])
    const existing = parseSession(jsonl)
    expect(existing.branchedFrom).toEqual(branchedFrom)

    const newJsonl = toJsonl([
      userMsg("Follow up"),
      textAssistant("Sure"),
    ])
    const updated = parseSessionAppend(existing, newJsonl)
    expect(updated.branchedFrom).toEqual(branchedFrom)
  })
})
