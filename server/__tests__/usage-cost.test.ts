// @vitest-environment node

import { describe, expect, it } from "vitest"
import {
  UsageCostAggregator,
  makeDayFormatter,
} from "../lib/usageCost/aggregate"
import { dedupeWithinFile } from "../lib/usageCost/reader"
import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeUsageLine,
  parseCodexUsageLine,
  type UsageCostRecord,
} from "../lib/usageCost/transcripts"
import {
  cacheSavingsUsd,
  lookupRate,
  normalizeModelName,
  parseRateTable,
  priceUsage,
} from "../../shared/usageCost/pricing"

const RATES = parseRateTable({
  "claude-opus-4-6": {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00005,
    cache_read_input_token_cost: 0.000001,
    cache_creation_input_token_cost: 0.0000125,
  },
  "anthropic/claude-sonnet-4-5": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
  },
  "broken-model": { input_cost_per_token: 0.000001 },
})

function claudeLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-19T12:00:00.000Z",
    sessionId: "session-1",
    requestId: "req-1",
    message: {
      id: "msg-1",
      model: "claude-opus-4-6",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
    },
    ...overrides,
  })
}

describe("pricing", () => {
  it("normalizes provider prefixes and case", () => {
    expect(normalizeModelName("Anthropic/Claude-Opus-4-6")).toBe("claude-opus-4-6")
    expect(lookupRate(RATES, "anthropic/claude-opus-4-6")).not.toBeNull()
    expect(lookupRate(RATES, "claude-sonnet-4-5")).not.toBeNull()
  })

  it("strips a [1m]-style context suffix", () => {
    expect(normalizeModelName("claude-opus-4-6[1m]")).toBe("claude-opus-4-6")
    expect(lookupRate(RATES, "claude-opus-4-6[1m]")).not.toBeNull()
  })

  it("drops entries missing an input or output rate", () => {
    expect(lookupRate(RATES, "broken-model")).toBeNull()
  })

  it("never prices synthetic or bare family names", () => {
    expect(lookupRate(RATES, "<synthetic>")).toBeNull()
    expect(lookupRate(RATES, "opus")).toBeNull()
  })

  it("prices all four token classes at their own rates", () => {
    const { costUsd, costSource } = priceUsage(
      RATES,
      "claude-opus-4-6",
      {
        uncachedInputTokens: 100,
        cachedInputTokens: 1000,
        cacheCreationTokens: 200,
        outputTokens: 50,
        reasoningTokens: 0,
      },
      null,
    )
    expect(costSource).toBe("modelPriced")
    expect(costUsd).toBeCloseTo(
      100 * 0.00001 + 1000 * 0.000001 + 200 * 0.0000125 + 50 * 0.00005,
      12,
    )
  })

  it("prefers a provider-reported cost over the table", () => {
    const priced = priceUsage(
      RATES,
      "claude-opus-4-6",
      { uncachedInputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1, reasoningTokens: 0 },
      1.23,
    )
    expect(priced).toEqual({ costUsd: 1.23, costSource: "providerReported" })
  })

  it("falls back to plain input rates for models without cache rates", () => {
    const totals = {
      uncachedInputTokens: 0,
      cachedInputTokens: 500,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    }
    const { costUsd } = priceUsage(RATES, "claude-sonnet-4-5", totals, null)
    expect(costUsd).toBeCloseTo(500 * 0.000003, 12)
    expect(cacheSavingsUsd(RATES, "claude-sonnet-4-5", totals)).toBe(0)
  })

  it("computes cache savings against the full input rate", () => {
    const totals = {
      uncachedInputTokens: 0,
      cachedInputTokens: 1000,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    }
    expect(cacheSavingsUsd(RATES, "claude-opus-4-6", totals)).toBeCloseTo(
      1000 * (0.00001 - 0.000001),
      12,
    )
  })
})

describe("parseClaudeUsageLine", () => {
  it("extracts a usage record from an assistant line", () => {
    const record = parseClaudeUsageLine(claudeLine())
    expect(record).toMatchObject({
      provider: "claude",
      model: "claude-opus-4-6",
      sessionId: "session-1",
      dedupeKey: "msg-1:req-1",
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 1000,
        cacheCreationTokens: 200,
        outputTokens: 50,
      },
    })
  })

  it("ignores non-assistant lines, malformed JSON, and missing usage", () => {
    expect(parseClaudeUsageLine(JSON.stringify({ type: "user" }))).toBeNull()
    expect(parseClaudeUsageLine("not json")).toBeNull()
    expect(
      parseClaudeUsageLine(JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-19T12:00:00.000Z",
        message: { model: "claude-opus-4-6" },
      })),
    ).toBeNull()
  })

  it("drops zero-token records like <synthetic> lines", () => {
    const record = parseClaudeUsageLine(claudeLine({
      message: {
        id: "msg-synth",
        model: "<synthetic>",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }))
    expect(record).toBeNull()
  })

  it("captures a reported costUSD when present", () => {
    const record = parseClaudeUsageLine(claudeLine({ costUSD: 0.42 }))
    expect(record?.reportedCostUsd).toBe(0.42)
  })

  it("gates lines cheaply on the usage substring", () => {
    expect(mightCarryUsage(claudeLine(), "claude")).toBe(true)
    expect(mightCarryUsage('{"type":"user"}', "claude")).toBe(false)
  })
})

describe("parseCodexUsageLine", () => {
  const meta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-19T10:00:00.000Z",
    payload: { id: "codex-session" },
  })
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-19T10:00:01.000Z",
    payload: { model: "gpt-5.1-codex" },
  })

  function tokenCount(timestamp: string, tokens: Record<string, number>): string {
    return JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: { type: "token_count", info: { last_token_usage: tokens } },
    })
  }

  it("attributes usage to the model from turn_context", () => {
    const state = initialCodexScanState()
    parseCodexUsageLine(meta, state)
    parseCodexUsageLine(turnContext, state)
    const record = parseCodexUsageLine(
      tokenCount("2026-08-19T10:00:30.000Z", {
        input_tokens: 1000,
        cached_input_tokens: 600,
        output_tokens: 80,
        reasoning_output_tokens: 30,
      }),
      state,
    )
    expect(record).toMatchObject({
      provider: "codex",
      model: "gpt-5.1-codex",
      sessionId: "codex-session",
      totals: {
        uncachedInputTokens: 400,
        cachedInputTokens: 600,
        outputTokens: 80,
        reasoningTokens: 30,
      },
    })
  })

  it("drops usage that arrives before any turn_context", () => {
    const state = initialCodexScanState()
    parseCodexUsageLine(meta, state)
    const early = tokenCount("2026-08-19T10:00:02.000Z", { input_tokens: 10, output_tokens: 5 })
    expect(parseCodexUsageLine(early, state)).toBeNull()
    // The same payload must still count once the model is known.
    parseCodexUsageLine(turnContext, state)
    expect(parseCodexUsageLine(early, state)).not.toBeNull()
  })

  it("skips consecutive duplicate token_count events", () => {
    const state = initialCodexScanState()
    parseCodexUsageLine(turnContext, state)
    const line = tokenCount("2026-08-19T10:01:00.000Z", { input_tokens: 10, output_tokens: 5 })
    expect(parseCodexUsageLine(line, state)).not.toBeNull()
    expect(parseCodexUsageLine(line, state)).toBeNull()
  })

  it("suppresses the fork-copy burst but keeps genuine child usage", () => {
    const state = initialCodexScanState()
    parseCodexUsageLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-19T10:00:00.000Z",
        payload: { id: "fork", forked_from_id: "parent" },
      }),
      state,
    )
    parseCodexUsageLine(turnContext, state)
    // Re-stamped parent history lands within the burst window.
    expect(
      parseCodexUsageLine(
        tokenCount("2026-08-19T10:00:00.100Z", { input_tokens: 10, output_tokens: 1 }),
        state,
      ),
    ).toBeNull()
    // The child's first real turn arrives seconds later.
    expect(
      parseCodexUsageLine(
        tokenCount("2026-08-19T10:00:07.000Z", { input_tokens: 20, output_tokens: 2 }),
        state,
      ),
    ).not.toBeNull()
  })
})

describe("aggregation", () => {
  function record(overrides: Partial<UsageCostRecord> = {}): UsageCostRecord {
    return {
      provider: "claude",
      timestampMs: Date.parse("2026-08-19T12:00:00.000Z"),
      model: "claude-opus-4-6",
      sessionId: "session-1",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      dedupeKey: null,
      ...overrides,
    }
  }

  it("dedupes globally across files by dedupeKey", () => {
    const aggregator = new UsageCostAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates: RATES,
    })
    expect(aggregator.add(record({ dedupeKey: "a:b" }))).toBe(true)
    expect(aggregator.add(record({ dedupeKey: "a:b" }))).toBe(false)
    const { buckets } = aggregator.finish()
    expect(buckets).toHaveLength(1)
    expect(buckets[0].records).toBe(1)
  })

  it("buckets by local day in the requested time zone", () => {
    const aggregator = new UsageCostAggregator({
      timeZone: "America/New_York",
      sinceDay: "2026-08-18",
      untilDay: "2026-08-19",
      rates: RATES,
    })
    // 01:00 UTC on the 19th is still the 18th in New York.
    aggregator.add(record({ timestampMs: Date.parse("2026-08-19T01:00:00.000Z") }))
    const { buckets } = aggregator.finish()
    expect(buckets[0].day).toBe("2026-08-18")
  })

  it("drops records outside the window and counts distinct sessions", () => {
    const aggregator = new UsageCostAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-19",
      untilDay: "2026-08-19",
      rates: RATES,
    })
    expect(aggregator.add(record({ timestampMs: Date.parse("2026-07-01T00:00:00.000Z") }))).toBe(false)
    aggregator.add(record({ sessionId: "a" }))
    aggregator.add(record({ sessionId: "b" }))
    const result = aggregator.finish()
    expect(result.distinctSessions).toBe(2)
    expect(result.buckets[0].sessions).toBe(2)
  })

  it("reports the weakest cost provenance in a mixed bucket", () => {
    const aggregator = new UsageCostAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-19",
      untilDay: "2026-08-19",
      rates: RATES,
    })
    aggregator.add(record({ model: "mystery-model" }))
    aggregator.add(record({ model: "mystery-model", reportedCostUsd: 0.5 }))
    const { buckets } = aggregator.finish()
    expect(buckets[0].costSource).toBe("modelPriced")
    expect(buckets[0].costUsd).toBe(0.5)
  })

  it("marks fully unknown models as unpriced with zero cost", () => {
    const aggregator = new UsageCostAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-19",
      untilDay: "2026-08-19",
      rates: RATES,
    })
    aggregator.add(record({ model: "mystery-model" }))
    const { buckets } = aggregator.finish()
    expect(buckets[0]).toMatchObject({ costSource: "unpriced", costUsd: 0 })
    expect(buckets[0].totals.uncachedInputTokens).toBe(100)
  })
})

describe("dedupeWithinFile", () => {
  it("keeps the first record per key and all keyless records", () => {
    const records = [
      parseClaudeUsageLine(claudeLine())!,
      parseClaudeUsageLine(claudeLine())!,
      { ...parseClaudeUsageLine(claudeLine())!, dedupeKey: null },
    ]
    expect(dedupeWithinFile(records)).toHaveLength(2)
  })
})

describe("makeDayFormatter", () => {
  it("degrades to UTC on an unknown zone", () => {
    const toDay = makeDayFormatter("Not/AZone")
    expect(toDay(Date.parse("2026-08-19T23:30:00.000Z"))).toBe("2026-08-19")
  })
})
