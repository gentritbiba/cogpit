import { describe, it, expect } from "vitest"
import {
  estimateThinkingTokens,
  estimateVisibleOutputTokens,
  formatCost,
  CHARS_PER_TOKEN,
} from "../../../shared/session/token-costs"
import { parseRateTable, priceTokenUsage } from "@/lib/usagePricing"
import type { Turn } from "../../../shared/session/types"

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

// ── output token estimation (display only) ───────────────────────────────────

describe("estimateThinkingTokens", () => {
  it("returns 0 with no thinking blocks", () => {
    expect(estimateThinkingTokens(makeTurn())).toBe(0)
  })

  it("estimates from thinking content at CHARS_PER_TOKEN", () => {
    const turn = makeTurn({
      thinking: [{ type: "thinking", thinking: "x".repeat(400), signature: "" }],
    })
    expect(estimateThinkingTokens(turn)).toBe(400 / CHARS_PER_TOKEN)
  })

  it("prefers the reported thinking token count over the estimate", () => {
    // CC 2.1.19x+ reports the thinking slice of output_tokens exactly.
    const turn = makeTurn({
      thinking: [{ type: "thinking", thinking: "x".repeat(400), signature: "" }],
      tokenUsage: {
        input_tokens: 10,
        output_tokens: 500,
        output_tokens_details: { thinking_tokens: 320 },
      },
    })
    expect(estimateThinkingTokens(turn)).toBe(320)
  })

  it("reports zero thinking tokens when the model reported exactly zero", () => {
    // A reported 0 is a fact, not a missing value — it must not fall back.
    const turn = makeTurn({
      thinking: [{ type: "thinking", thinking: "x".repeat(400), signature: "" }],
      tokenUsage: {
        input_tokens: 10,
        output_tokens: 500,
        output_tokens_details: { thinking_tokens: 0 },
      },
    })
    expect(estimateThinkingTokens(turn)).toBe(0)
  })

  it("falls back to the estimate when the details field is absent", () => {
    const turn = makeTurn({
      thinking: [{ type: "thinking", thinking: "x".repeat(400), signature: "" }],
      tokenUsage: { input_tokens: 10, output_tokens: 500 },
    })
    expect(estimateThinkingTokens(turn)).toBe(400 / CHARS_PER_TOKEN)
  })
})

describe("estimateVisibleOutputTokens", () => {
  it("estimates from assistant text", () => {
    const turn = makeTurn({ assistantText: ["hello world"] }) // 11 chars
    expect(estimateVisibleOutputTokens(turn)).toBe(Math.ceil(11 / CHARS_PER_TOKEN))
  })

  it("includes tool input JSON", () => {
    const turn = makeTurn({
      toolCalls: [
        { id: "tc1", name: "Bash", input: { command: "ls" }, result: null, isError: false, timestamp: "" },
      ],
    })
    const jsonLen = JSON.stringify({ command: "ls" }).length
    expect(estimateVisibleOutputTokens(turn)).toBe(Math.ceil(jsonLen / CHARS_PER_TOKEN))
  })
})

// ── raw API pricing via the LiteLLM rate table ───────────────────────────────

describe("priceTokenUsage", () => {
  const rates = parseRateTable({
    "claude-opus-4-6": {
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000025,
      cache_read_input_token_cost: 0.0000005,
      cache_creation_input_token_cost: 0.00000625,
    },
  })

  it("prices raw reported tokens per class", () => {
    const cost = priceTokenUsage(rates, "claude-opus-4-6", {
      input_tokens: 100_000,
      output_tokens: 10_000,
      cache_creation_input_tokens: 30_000,
      cache_read_input_tokens: 50_000,
    })
    expect(cost).toBeCloseTo(
      100_000 * 0.000005
        + 10_000 * 0.000025
        + 30_000 * 0.00000625
        + 50_000 * 0.0000005,
      10,
    )
  })

  it("returns 0 for unknown or missing models instead of guessing", () => {
    const usage = { input_tokens: 100_000, output_tokens: 0 }
    expect(priceTokenUsage(rates, "mystery-model", usage)).toBe(0)
    expect(priceTokenUsage(rates, null, usage)).toBe(0)
  })
})

// ── formatCost ───────────────────────────────────────────────────────────────

describe("formatCost", () => {
  it("formats sub-cent costs with 4 decimals", () => {
    expect(formatCost(0.0012)).toBe("$0.0012")
  })

  it("formats sub-dollar costs with 3 decimals", () => {
    expect(formatCost(0.123)).toBe("$0.123")
  })

  it("formats dollar costs with 2 decimals", () => {
    expect(formatCost(12.345)).toBe("$12.35")
  })

  it("renders non-finite costs as a dash", () => {
    expect(formatCost(Number.NaN)).toBe("—")
  })
})
