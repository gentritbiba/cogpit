import { describe, it, expect } from "vitest"
import { computeModelBreakdown } from "@/lib/costAnalytics"
import { shortenModel } from "@/lib/format"
import type { Turn } from "@/lib/types"

function turn(model: string | null, inputTokens: number): Turn {
  return {
    id: `turn-${model}-${inputTokens}`,
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2026-01-01T00:00:00Z",
    durationMs: null,
    tokenUsage: { input_tokens: inputTokens, output_tokens: 0 },
    model,
  }
}

describe("computeModelBreakdown", () => {
  it("merges different versions of one family into a single row", () => {
    const rows = computeModelBreakdown(
      [turn("claude-opus-4-8", 100), turn("claude-opus-4-6-20250115", 50)],
      shortenModel,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].shortName).toBe("opus")
    expect(rows[0].input).toBe(150)
  })

  it("keeps distinct families as separate rows", () => {
    const rows = computeModelBreakdown(
      [turn("claude-opus-4-8", 100), turn("claude-sonnet-5", 50)],
      shortenModel,
    )
    expect(rows.map((r) => r.shortName).sort()).toEqual(["opus", "sonnet"])
  })

  it("buckets turns without a model as 'unknown'", () => {
    const rows = computeModelBreakdown([turn(null, 10)], shortenModel)
    expect(rows).toHaveLength(1)
    expect(rows[0].shortName).toBe("unknown")
  })

  it("prices each version with its own rate before merging", () => {
    // opus 4.6+ input = $5/M, opus 4.0 (legacy) input = $15/M
    const rows = computeModelBreakdown(
      [turn("claude-opus-4-6-20250115", 1_000_000), turn("claude-opus-4-0-20250101", 1_000_000)],
      shortenModel,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].cost).toBeCloseTo(5 + 15)
  })
})
