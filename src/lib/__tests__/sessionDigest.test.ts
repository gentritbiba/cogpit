import { describe, it, expect, beforeEach } from "vitest"
import { assistantMsg, resetFixtureCounter } from "@/__tests__/fixtures"
import { computeSessionDigest } from "../../../shared/session/sessionDigest"
import type { RawMessage, RawRecord } from "../../../shared/session/types"

const contextUsageOf = (records: RawMessage[]) => computeSessionDigest(records).contextUsage
const goalOf = (records: RawRecord[]) => computeSessionDigest(records).goal

beforeEach(() => {
  resetFixtureCounter()
})

describe("digest context usage", () => {
  it("returns null for empty array", () => {
    expect(contextUsageOf([])).toBeNull()
  })

  it("returns null when no assistant messages exist", () => {
    const msgs: RawMessage[] = [
      { type: "user", message: { role: "user", content: "hi" } } as RawMessage,
    ]
    expect(contextUsageOf(msgs)).toBeNull()
  })

  it("computes usage from the last assistant message", () => {
    const msg = assistantMsg([{ type: "text", text: "ok" }], {
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 50_000,
          output_tokens: 1_000,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 5_000,
        },
      },
    })
    const result = contextUsageOf([msg])
    expect(result).not.toBeNull()
    // used = 50000 + 10000 + 5000 = 65000
    expect(result!.used).toBe(65_000)
    expect(result!.limit).toBe(1_000_000)
    // compactAt = 1000000 - 33000 = 967000
    expect(result!.compactAt).toBe(967_000)
    // percent = (65000 / 967000) * 100
    expect(result!.percent).toBeCloseTo((65_000 / 967_000) * 100, 1)
    expect(result!.percentAbsolute).toBeCloseTo((65_000 / 1_000_000) * 100, 1)
  })

  it("uses the last assistant message when multiple exist", () => {
    const msg1 = assistantMsg([{ type: "text", text: "first" }], {
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10_000, output_tokens: 500 },
      },
    })
    const msg2 = assistantMsg([{ type: "text", text: "second" }], {
      message: {
        model: "claude-sonnet-4-5-20250101",
        id: "msg_2",
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 80_000, output_tokens: 2_000 },
      },
    })
    const result = contextUsageOf([msg1, msg2])
    // Should use msg2 (last assistant message)
    expect(result!.used).toBe(80_000)
  })

  it("caps percent at 100", () => {
    const msg = assistantMsg([{ type: "text", text: "big" }], {
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "big" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 990_000, output_tokens: 0 },
      },
    })
    const result = contextUsageOf([msg])
    // used=990000, compactAt=967000 => percent > 100, should cap
    expect(result!.percent).toBe(100)
    expect(result!.percentAbsolute).toBeCloseTo((990_000 / 1_000_000) * 100, 1)
  })

  it("handles missing optional cache fields", () => {
    const msg = assistantMsg([{ type: "text", text: "ok" }], {
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 30_000, output_tokens: 500 },
      },
    })
    const result = contextUsageOf([msg])
    expect(result!.used).toBe(30_000)
  })

  it("computes exact percent at compactAt boundary", () => {
    // compactAt = 1000000 - 33000 = 967000
    const msg = assistantMsg([{ type: "text", text: "boundary" }], {
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_boundary",
        role: "assistant",
        content: [{ type: "text", text: "boundary" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 967_000, output_tokens: 0 },
      },
    })
    const result = contextUsageOf([msg])
    // used = 967000, compactAt = 967000 => exactly 100%
    expect(result!.percent).toBe(100)
    expect(result!.percentAbsolute).toBeCloseTo((967_000 / 1_000_000) * 100, 1)
  })

  it("returns 0 percent when used is 0", () => {
    const msg = assistantMsg([{ type: "text", text: "empty" }], {
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_zero",
        role: "assistant",
        content: [{ type: "text", text: "empty" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    const result = contextUsageOf([msg])
    expect(result!.used).toBe(0)
    expect(result!.percent).toBe(0)
    expect(result!.percentAbsolute).toBe(0)
  })

  it("skips non-assistant messages when searching backwards", () => {
    const assistantRaw = assistantMsg([{ type: "text", text: "data" }], {
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_mixed",
        role: "assistant",
        content: [{ type: "text", text: "data" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 40_000, output_tokens: 1_000 },
      },
    })
    const userRaw = { type: "user", message: { role: "user", content: "hi" } } as RawMessage
    const systemRaw = { type: "system", subtype: "turn_duration", durationMs: 1000 } as RawMessage
    // assistant is first, then user, then system
    const result = contextUsageOf([assistantRaw, userRaw, systemRaw])
    // Should find the assistant message
    expect(result!.used).toBe(40_000)
  })
})

describe("digest goal state", () => {
  it("returns the latest active goal and evaluator progress", () => {
    expect(goalOf([
      { type: "attachment", attachment: { type: "goal_status", sentinel: true, met: false, condition: "tests pass" } },
      { type: "attachment", attachment: { type: "goal_status", met: false, condition: "tests pass", reason: "lint still fails", iterations: 2, durationMs: 90_000, tokens: 12_345 } },
    ])).toEqual({
      condition: "tests pass",
      status: "active",
      reason: "lint still fails",
      iterations: 2,
      durationMs: 90_000,
      tokens: 12_345,
    })
  })

  it("distinguishes achieved and failed evaluations", () => {
    expect(goalOf([
      { type: "attachment", attachment: { type: "goal_status", met: true, condition: "ship", iterations: 3 } },
    ])?.status).toBe("achieved")
    expect(goalOf([
      { type: "attachment", attachment: { type: "goal_status", failed: true, condition: "ship" } },
    ])?.status).toBe("failed")
  })

  it("treats Claude's met sentinel as an explicit clear boundary", () => {
    expect(goalOf([
      { type: "attachment", attachment: { type: "goal_status", met: false, condition: "old goal" } },
      { type: "attachment", attachment: { type: "goal_status", sentinel: true, met: true, condition: "old goal" } },
    ])).toBeNull()
  })
})

describe("computeSessionDigest", () => {
  const goal = (condition: string): RawRecord => ({ type: "attachment", attachment: { type: "goal_status", met: false, condition } })
  const fallback = (uuid: string): RawRecord => ({ type: "system", subtype: "model_refusal_fallback", uuid, original_model: "Fable", fallback_model: "Opus" })

  it("reads the latest model fallback", () => {
    expect(computeSessionDigest([fallback("a"), fallback("b")]).modelFallback).toEqual({
      id: "b", originalModel: "Fable", fallbackModel: "Opus", explanation: null,
    })
  })

  it("searches only records added since the previous digest, and keeps what they do not change", () => {
    const records: RawRecord[] = [goal("first"), fallback("a")]
    const previous = computeSessionDigest(records)
    records.push({ type: "user", message: { role: "user", content: "hi" } })
    const next = computeSessionDigest(records, { digest: previous, scannedTo: 2 })
    expect(next.goal).toBe(previous.goal)
    expect(next.modelFallback).toBe(previous.modelFallback)
    expect(next.status).toEqual(computeSessionDigest(records).status)

    records.push(goal("second"))
    expect(computeSessionDigest(records, { digest: next, scannedTo: 3 }).goal?.condition).toBe("second")
  })
})
