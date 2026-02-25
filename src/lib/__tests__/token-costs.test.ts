import { describe, it, expect } from "vitest"
import {
  calculateCost,
  calculateTurnCost,
  calculateTurnCostEstimated,
  calculateSubAgentCostEstimated,
  estimateThinkingTokens,
  estimateVisibleOutputTokens,
  estimateTotalOutputTokens,
  estimateSubAgentOutput,
  formatCost,
  CHARS_PER_TOKEN,
} from "@/lib/token-costs"
import type { Turn, SubAgentMessage } from "@/lib/types"

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "t1",
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "",
    durationMs: null,
    tokenUsage: null,
    model: null,
    ...overrides,
  }
}

function makeSubAgent(overrides: Partial<SubAgentMessage> = {}): SubAgentMessage {
  return {
    agentId: "sa1",
    type: "assistant",
    content: [],
    toolCalls: [],
    thinking: [],
    text: [],
    timestamp: "",
    tokenUsage: null,
    model: null,
    isBackground: false,
    ...overrides,
  }
}

// ── calculateCost — pricing tiers ────────────────────────────────────────────

describe("calculateCost", () => {
  // Use 100k tokens (under 200k threshold) so extended pricing doesn't kick in
  describe("latest tier (opus 4.5/4.6, sonnet 4.5/4.6): $5/$25", () => {
    const models = [
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
    ]
    for (const model of models) {
      it(`${model}: input=$5/M, output=$25/M`, () => {
        const cost = calculateCost({ model, inputTokens: 100_000, outputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 0 })
        // 100k input * $5/M + 100k output * $25/M = 0.5 + 2.5 = 3
        expect(cost).toBeCloseTo(3)
      })
      it(`${model}: cacheWrite=$6.25/M, cacheRead=$0.50/M`, () => {
        const cost = calculateCost({ model, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 100_000, cacheReadTokens: 100_000 })
        // 100k cacheWrite * $6.25/M + 100k cacheRead * $0.50/M = 0.625 + 0.05 = 0.675
        expect(cost).toBeCloseTo(0.675)
      })
    }
  })

  describe("sonnet legacy tier (3.5, 3.7, 4.0): $3/$15", () => {
    const models = [
      "claude-sonnet-4-0-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
    ]
    for (const model of models) {
      it(`${model}: input=$3/M, output=$15/M`, () => {
        const cost = calculateCost({ model, inputTokens: 100_000, outputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 0 })
        // 100k * $3/M + 100k * $15/M = 0.3 + 1.5 = 1.8
        expect(cost).toBeCloseTo(1.8)
      })
    }
  })

  describe("opus legacy tier (4.0, 4.1): $15/$75", () => {
    const models = [
      "claude-opus-4-0-20250514",
      "claude-opus-4-1-20250805",
    ]
    for (const model of models) {
      it(`${model}: input=$15/M, output=$75/M`, () => {
        const cost = calculateCost({ model, inputTokens: 100_000, outputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 0 })
        // 100k * $15/M + 100k * $75/M = 1.5 + 7.5 = 9
        expect(cost).toBeCloseTo(9)
      })
    }
  })

  describe("haiku tiers", () => {
    it("haiku 4.5: $1/$5", () => {
      const cost = calculateCost({ model: "claude-haiku-4-5-20251001", inputTokens: 100_000, outputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 0 })
      expect(cost).toBeCloseTo(0.6) // 0.1 + 0.5
    })
    it("haiku 3.5: $0.80/$4", () => {
      const cost = calculateCost({ model: "claude-3-5-haiku-20241022", inputTokens: 100_000, outputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 0 })
      expect(cost).toBeCloseTo(0.48) // 0.08 + 0.4
    })
  })

  describe("extended context pricing (>200k total input)", () => {
    it("opus 4.6 extended: $10/$37.5", () => {
      // Total input = 150k input + 60k cacheRead = 210k > 200k → extended
      const cost = calculateCost({
        model: "claude-opus-4-6",
        inputTokens: 150_000,
        outputTokens: 100_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 60_000,
      })
      const expected = (150_000 / 1e6) * 10 + (100_000 / 1e6) * 37.5 + (60_000 / 1e6) * 1
      expect(cost).toBeCloseTo(expected)
    })

    it("sonnet 4.0 extended: $6/$22.5", () => {
      const cost = calculateCost({
        model: "claude-sonnet-4-0-20250514",
        inputTokens: 210_000,
        outputTokens: 100_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      })
      const expected = (210_000 / 1e6) * 6 + (100_000 / 1e6) * 22.5
      expect(cost).toBeCloseTo(expected)
    })

    it("standard pricing when under 200k threshold", () => {
      const cost = calculateCost({
        model: "claude-opus-4-6",
        inputTokens: 100_000,
        outputTokens: 100_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      })
      const expected = (100_000 / 1e6) * 5 + (100_000 / 1e6) * 25
      expect(cost).toBeCloseTo(expected)
    })
  })

  it("includes web search requests", () => {
    const cost = calculateCost({
      model: "claude-opus-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 5,
    })
    expect(cost).toBeCloseTo(0.05) // 5 * $0.01
  })

  it("fallback for unknown models uses latest tier (extended when >200k)", () => {
    // 100k input → under threshold → standard $5/M
    const cost = calculateCost({ model: "unknown-model", inputTokens: 100_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })
    expect(cost).toBeCloseTo(0.5) // 100k * $5/M
  })

  it("null model uses latest tier", () => {
    const cost = calculateCost({ model: null, inputTokens: 100_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })
    expect(cost).toBeCloseTo(0.5) // 100k * $5/M
  })

  it("returns 0 for zero everything", () => {
    expect(calculateCost({ model: "claude-opus-4-6", inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBe(0)
  })
})

// ── calculateTurnCost (backward-compat wrapper) ──────────────────────────────

describe("calculateTurnCost", () => {
  it("delegates to calculateCost correctly", () => {
    const a = calculateTurnCost("claude-opus-4-6", 100_000, 50_000, 20_000, 10_000)
    const b = calculateCost({ model: "claude-opus-4-6", inputTokens: 100_000, outputTokens: 50_000, cacheWriteTokens: 20_000, cacheReadTokens: 10_000 })
    expect(a).toBe(b)
  })
})

// ── Output token estimation ──────────────────────────────────────────────────

describe("estimateThinkingTokens", () => {
  it("returns 0 for no thinking blocks", () => {
    expect(estimateThinkingTokens(makeTurn())).toBe(0)
  })

  it("estimates tokens from thinking content", () => {
    const turn = makeTurn({
      thinking: [{ type: "thinking", thinking: "a".repeat(400), signature: "" }],
    })
    expect(estimateThinkingTokens(turn)).toBe(100) // 400 / 4
  })

  it("sums multiple thinking blocks", () => {
    const turn = makeTurn({
      thinking: [
        { type: "thinking", thinking: "a".repeat(100), signature: "" },
        { type: "thinking", thinking: "b".repeat(300), signature: "" },
      ],
    })
    expect(estimateThinkingTokens(turn)).toBe(100) // (100 + 300) / 4
  })
})

describe("estimateVisibleOutputTokens", () => {
  it("estimates from text", () => {
    const turn = makeTurn({ assistantText: ["hello world"] }) // 11 chars
    expect(estimateVisibleOutputTokens(turn)).toBe(Math.ceil(11 / CHARS_PER_TOKEN))
  })

  it("includes tool call input JSON", () => {
    const input = { file_path: "/foo/bar.ts" }
    const turn = makeTurn({
      toolCalls: [{ id: "tc1", name: "Read", input, result: null, isError: false, timestamp: "" }],
    })
    const expectedChars = JSON.stringify(input).length
    expect(estimateVisibleOutputTokens(turn)).toBe(Math.ceil(expectedChars / CHARS_PER_TOKEN))
  })
})

describe("estimateTotalOutputTokens", () => {
  it("returns max of estimated and reported", () => {
    const turn = makeTurn({
      thinking: [{ type: "thinking", thinking: "a".repeat(400), signature: "" }],
      assistantText: ["b".repeat(400)],
      tokenUsage: { input_tokens: 0, output_tokens: 50 },
    })
    // estimated = 100 + 100 = 200, reported = 50 → max = 200
    expect(estimateTotalOutputTokens(turn)).toBe(200)
  })

  it("uses reported when higher", () => {
    const turn = makeTurn({
      assistantText: ["hi"], // 2 chars → 1 token
      tokenUsage: { input_tokens: 0, output_tokens: 500 },
    })
    expect(estimateTotalOutputTokens(turn)).toBe(500)
  })
})

describe("estimateSubAgentOutput", () => {
  it("estimates from thinking + text + tool calls", () => {
    const sa = makeSubAgent({
      thinking: ["a".repeat(100)],
      text: ["b".repeat(200)],
      toolCalls: [{ id: "tc1", name: "Bash", input: { command: "ls" }, result: null, isError: false, timestamp: "" }],
    })
    const inputChars = JSON.stringify({ command: "ls" }).length
    const expected = Math.ceil((100 + 200 + inputChars) / CHARS_PER_TOKEN)
    expect(estimateSubAgentOutput(sa)).toBe(expected)
  })
})

// ── Turn-level cost helpers ──────────────────────────────────────────────────

describe("calculateTurnCostEstimated", () => {
  it("returns 0 if no usage", () => {
    expect(calculateTurnCostEstimated(makeTurn())).toBe(0)
  })

  it("uses estimated output in cost calculation", () => {
    const turn = makeTurn({
      model: "claude-opus-4-6",
      assistantText: ["a".repeat(400)], // 100 tokens
      tokenUsage: { input_tokens: 1000, output_tokens: 5 },
    })
    const cost = calculateTurnCostEstimated(turn)
    // Should use estimated (100) not reported (5)
    const expected = calculateCost({
      model: "claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 100,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    })
    expect(cost).toBeCloseTo(expected)
  })
})

describe("calculateSubAgentCostEstimated", () => {
  it("returns 0 if no usage", () => {
    expect(calculateSubAgentCostEstimated(makeSubAgent())).toBe(0)
  })

  it("uses estimated output for sub-agent", () => {
    const sa = makeSubAgent({
      model: "claude-sonnet-4-6",
      text: ["a".repeat(800)], // 200 tokens
      tokenUsage: { input_tokens: 500, output_tokens: 3 },
    })
    const cost = calculateSubAgentCostEstimated(sa)
    const expected = calculateCost({
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 200,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    })
    expect(cost).toBeCloseTo(expected)
  })
})

// ── formatCost ───────────────────────────────────────────────────────────────

describe("formatCost", () => {
  it("formats costs under $0.01 with 4 decimal places", () => {
    expect(formatCost(0.0012)).toBe("$0.0012")
  })

  it("formats costs under $1 with 3 decimal places", () => {
    expect(formatCost(0.123)).toBe("$0.123")
  })

  it("formats costs >= $1 with 2 decimal places", () => {
    expect(formatCost(12.345)).toBe("$12.35")
  })

  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.0000")
  })
})
