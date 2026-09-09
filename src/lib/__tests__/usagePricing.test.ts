import { describe, it, expect } from "vitest"
import { parseRateTable, priceTokenUsage } from "@/lib/usagePricing"
import type { TokenUsage } from "../../../shared/session/types"

// A miniature LiteLLM document. Each token class carries a distinct rate so a
// test that mixes two classes up produces a different number.
const rates = parseRateTable({
  "claude-opus-4-6": {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.00000625,
    cache_creation_input_token_cost_above_1hr: 0.00001,
    input_cost_per_token_priority: 0.00001,
    output_cost_per_token_priority: 0.00005,
  },
  // A bare family name the table knows about but that spans generations.
  opus: {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
  },
  // Whole-request long-context pricing: crossing the threshold reprices every
  // token of the request, not just the ones past it.
  "gpt-test": {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000004,
    input_cost_per_token_above_128k_tokens: 0.000002,
    output_cost_per_token_above_128k_tokens: 0.000008,
  },
})

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, ...overrides }
}

describe("priceTokenUsage", () => {
  it("charges each token class at its own rate", () => {
    const cost = priceTokenUsage(rates, "claude-opus-4-6", usage({
      input_tokens: 100_000,
      output_tokens: 10_000,
      cache_creation_input_tokens: 30_000,
      cache_read_input_tokens: 50_000,
    }))
    expect(cost).toBeCloseTo(
      100_000 * 0.000005
      + 10_000 * 0.000025
      + 30_000 * 0.00000625
      + 50_000 * 0.0000005,
      10,
    )
  })

  it("prices cache reads at the discounted rate, not the input rate", () => {
    const cached = priceTokenUsage(rates, "claude-opus-4-6", usage({
      cache_read_input_tokens: 100_000,
    }))
    expect(cached).toBeCloseTo(100_000 * 0.0000005, 10)
    // Ten times cheaper than sending the same tokens uncached.
    expect(cached).toBeCloseTo(
      priceTokenUsage(rates, "claude-opus-4-6", usage({ input_tokens: 100_000 })) / 10,
      10,
    )
  })

  it("prices the whole cache write at the 5-minute rate", () => {
    // Per-turn usage carries no TTL split, so none of it may be charged the
    // 1-hour premium even for a model that publishes one.
    const cost = priceTokenUsage(rates, "claude-opus-4-6", usage({
      cache_creation_input_tokens: 40_000,
    }))
    expect(cost).toBeCloseTo(40_000 * 0.00000625, 10)
    expect(cost).not.toBeCloseTo(40_000 * 0.00001, 10)
  })

  it("ignores a fast-mode marker on the usage record", () => {
    // The transcript's `speed` field is not forwarded, so a priority-priced
    // model is still billed at its standard rate here.
    const fast = priceTokenUsage(rates, "claude-opus-4-6", usage({
      input_tokens: 1_000,
      output_tokens: 100,
      speed: "fast",
    }))
    expect(fast).toBeCloseTo(1_000 * 0.000005 + 100 * 0.000025, 10)
  })

  it("does not charge reported thinking tokens on top of output tokens", () => {
    // thinking_tokens is a slice of output_tokens, already paid for.
    const withThinking = priceTokenUsage(rates, "claude-opus-4-6", usage({
      output_tokens: 10_000,
      output_tokens_details: { thinking_tokens: 4_000 },
    }))
    expect(withThinking).toBeCloseTo(10_000 * 0.000025, 10)
  })

  it("treats absent cache fields as zero rather than as unpriceable tokens", () => {
    const cost = priceTokenUsage(rates, "claude-opus-4-6", usage({
      input_tokens: 1_000,
      output_tokens: 200,
    }))
    expect(Number.isFinite(cost)).toBe(true)
    expect(cost).toBeCloseTo(1_000 * 0.000005 + 200 * 0.000025, 10)
  })

  it("returns exactly 0 for an all-zero usage record", () => {
    expect(priceTokenUsage(rates, "claude-opus-4-6", usage({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }))).toBe(0)
  })

  it("counts cached input toward the long-context tier", () => {
    // 100k uncached + 50k cached crosses the 128k threshold, which reprices
    // the whole request — including the output tokens.
    const long = priceTokenUsage(rates, "gpt-test", usage({
      input_tokens: 100_000,
      output_tokens: 10_000,
      cache_read_input_tokens: 50_000,
    }))
    expect(long).toBeCloseTo(
      100_000 * 0.000002 + 50_000 * 0.000001 + 10_000 * 0.000008,
      10,
    )

    const short = priceTokenUsage(rates, "gpt-test", usage({
      input_tokens: 100_000,
      output_tokens: 10_000,
    }))
    expect(short).toBeCloseTo(100_000 * 0.000001 + 10_000 * 0.000004, 10)
  })

  it("resolves provider prefixes and context-window suffixes to the same rate", () => {
    const expected = priceTokenUsage(rates, "claude-opus-4-6", usage({ input_tokens: 1_000 }))
    expect(expected).toBeGreaterThan(0)
    expect(priceTokenUsage(rates, "anthropic/claude-opus-4-6", usage({ input_tokens: 1_000 })))
      .toBeCloseTo(expected, 10)
    expect(priceTokenUsage(rates, "claude-opus-4-6[1m]", usage({ input_tokens: 1_000 })))
      .toBeCloseTo(expected, 10)
  })

  it("reports 0 rather than guessing for models the table cannot price", () => {
    const tokens = usage({ input_tokens: 100_000, output_tokens: 10_000 })
    expect(priceTokenUsage(rates, "mystery-model", tokens)).toBe(0)
    expect(priceTokenUsage(rates, null, tokens)).toBe(0)
    expect(priceTokenUsage(rates, "", tokens)).toBe(0)
    // A bare family name is ambiguous across generations, so it stays unpriced
    // even though the table has an entry under that key.
    expect(priceTokenUsage(rates, "opus", tokens)).toBe(0)
    expect(priceTokenUsage(rates, "<synthetic>", tokens)).toBe(0)
  })

  it("returns a finite number for every unknown-model path", () => {
    // ToolCallIndex divides this by the turn's tool-call count, so a NaN here
    // would render as "—" for a turn that really did cost something.
    for (const model of [null, "", "mystery-model", "opus"]) {
      expect(Number.isFinite(priceTokenUsage(rates, model, usage({ input_tokens: 10 }))))
        .toBe(true)
    }
  })
})
