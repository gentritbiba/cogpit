import { describe, it, expect } from "vitest"
import {
  deriveSessionStatus,
  getStatusLabel,
} from "../sessionStatus"

describe("deriveSessionStatus", () => {
  it("returns idle for empty messages", () => {
    expect(deriveSessionStatus([])).toEqual({ status: "idle" })
  })

  it("returns completed when last assistant has end_turn and there was user activity", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [] } },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("completed")
  })

  it("returns idle when end_turn but no real user messages", () => {
    const msgs = [
      { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [] } },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("idle")
  })

  it("returns idle when end_turn and only meta user messages", () => {
    const msgs = [
      { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("idle")
  })

  it("returns thinking when stop_reason is null (streaming)", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { role: "assistant", stop_reason: null, content: [] } },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("thinking")
  })

  it("returns tool_use with tool name", () => {
    const msgs = [
      { type: "assistant", message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me read that" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      }},
    ]
    const result = deriveSessionStatus(msgs)
    expect(result.status).toBe("tool_use")
    expect(result.toolName).toBe("Read")
  })

  it("returns processing for tool_result user message", () => {
    const msgs = [
      { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Read" }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] } },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("processing")
  })

  it("returns processing for regular user message", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "do something" } },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("processing")
  })

  it("skips meta user messages to find real status", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("completed")
  })

  it("skips system/progress messages to find real status", () => {
    const msgs = [
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "system", subtype: "turn_duration" },
      { type: "progress", data: {} },
    ]
    // No real user messages, so idle not completed
    expect(deriveSessionStatus(msgs).status).toBe("idle")
  })

  it("skips summary markers to find real status behind them", () => {
    const msgs = [
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "system", subtype: "turn_duration" },
      { type: "summary", summary: "compacted" },
    ]
    // Finished-compaction markers are skipped — live compaction is detected via subagent file watcher
    expect(deriveSessionStatus(msgs).status).toBe("idle")
  })

  it("skips compact_boundary markers to find real status behind them", () => {
    const msgs = [
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "system", subtype: "turn_duration" },
      { type: "system", subtype: "compact_boundary", content: "Conversation compacted", isMeta: false },
    ]
    // Finished-compaction markers are skipped — live compaction is detected via subagent file watcher
    expect(deriveSessionStatus(msgs).status).toBe("idle")
  })

  it("skips file-history-snapshot messages to find real status", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "file-history-snapshot", snapshot: {} },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("completed")
  })

  it("tracks pending queue count from queue-operations", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "queue-operation", operation: "enqueue" },
      { type: "queue-operation", operation: "enqueue" },
    ]
    const result = deriveSessionStatus(msgs)
    expect(result.status).toBe("completed")
    expect(result.pendingQueue).toBe(2)
  })

  it("decrements pending queue count on dequeue", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "queue-operation", operation: "enqueue" },
      { type: "queue-operation", operation: "enqueue" },
      { type: "queue-operation", operation: "dequeue" },
    ]
    const result = deriveSessionStatus(msgs)
    expect(result.status).toBe("completed")
    expect(result.pendingQueue).toBe(1)
  })

  it("clamps pending queue count to 0 when negative", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "queue-operation", operation: "dequeue" },
    ]
    const result = deriveSessionStatus(msgs)
    expect(result.pendingQueue).toBe(0)
  })

  it("treats unknown stop_reason as thinking (catch-all)", () => {
    const msgs = [
      { type: "assistant", message: { stop_reason: "max_tokens", content: [] } },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("thinking")
  })

  it("handles multiple system/progress messages after end_turn", () => {
    const msgs = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
      { type: "system", subtype: "turn_duration" },
      { type: "progress", data: {} },
      { type: "system", subtype: "something_else" },
      { type: "file-history-snapshot" },
    ]
    expect(deriveSessionStatus(msgs).status).toBe("completed")
  })
})

describe("getStatusLabel", () => {
  it("returns null for idle", () => {
    expect(getStatusLabel("idle")).toBeNull()
  })

  it("returns null for undefined", () => {
    expect(getStatusLabel(undefined)).toBeNull()
  })

  it("returns Thinking... for thinking", () => {
    expect(getStatusLabel("thinking")).toBe("Thinking...")
  })

  it("returns tool name for tool_use", () => {
    expect(getStatusLabel("tool_use", "Edit")).toBe("Using Edit")
  })

  it("returns Running agents... for Agent tool", () => {
    expect(getStatusLabel("tool_use", "Agent")).toBe("Running agents...")
    expect(getStatusLabel("tool_use", "TaskOutput")).toBe("Running agents...")
  })

  it("returns generic label for tool_use without name", () => {
    expect(getStatusLabel("tool_use")).toBe("Using tool...")
  })

  it("returns Processing... for processing", () => {
    expect(getStatusLabel("processing")).toBe("Processing...")
  })

  it("returns Compressing context... for compacting", () => {
    expect(getStatusLabel("compacting")).toBe("Compressing context...")
  })

  it("returns Done for completed", () => {
    expect(getStatusLabel("completed")).toBe("Done")
  })
})
