import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  shortenModel,
  formatTokenCount,
  formatDuration,
  formatFileSize,
  formatRelativeTime,
  truncate,
  calculateTurnCost,
  formatCost,
  getContextLimit,
  getContextUsage,
} from "@/lib/format"
import { assistantMsg, resetFixtureCounter } from "@/__tests__/fixtures"
import type { RawMessage } from "@/lib/types"

beforeEach(() => {
  resetFixtureCounter()
})

// ── shortenModel ──────────────────────────────────────────────────────────

describe("shortenModel", () => {
  it("returns 'unknown' for empty string", () => {
    expect(shortenModel("")).toBe("unknown")
  })

  it("shortens opus 4.6 model ids", () => {
    expect(shortenModel("claude-opus-4-6-20250115")).toBe("opus 4.6")
  })

  it("shortens opus 4.5 model ids", () => {
    expect(shortenModel("claude-opus-4-5-20250101")).toBe("opus 4.5")
  })

  it("shortens sonnet 4.6 model ids", () => {
    expect(shortenModel("claude-sonnet-4-6-20250115")).toBe("sonnet 4.6")
  })

  it("shortens sonnet 4.5 model ids", () => {
    expect(shortenModel("claude-sonnet-4-5-20250101")).toBe("sonnet 4.5")
  })

  it("shortens haiku 4.5 model ids", () => {
    expect(shortenModel("claude-haiku-4-5-20250101")).toBe("haiku 4.5")
  })

  it("shortens opus 4.0 model ids", () => {
    expect(shortenModel("claude-opus-4-0-20250101")).toBe("opus 4")
  })

  it("shortens sonnet 4.0 model ids", () => {
    expect(shortenModel("claude-sonnet-4-0-20250101")).toBe("sonnet 4")
  })

  it("shortens generic opus to 'opus'", () => {
    expect(shortenModel("claude-opus-future")).toBe("opus")
  })

  it("shortens generic sonnet to 'sonnet'", () => {
    expect(shortenModel("claude-sonnet-future")).toBe("sonnet")
  })

  it("shortens generic haiku to 'haiku'", () => {
    expect(shortenModel("claude-haiku-future")).toBe("haiku")
  })

  it("truncates long unknown model names", () => {
    const longName = "some-very-long-model-name-that-exceeds-twenty-chars"
    expect(shortenModel(longName)).toBe("some-very-long-model...")
  })

  it("returns short unknown model names as-is", () => {
    expect(shortenModel("gpt-4")).toBe("gpt-4")
  })
})

// ── formatTokenCount ──────────────────────────────────────────────────────

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M")
  })

  it("formats exactly 1M", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M")
  })

  it("formats thousands", () => {
    expect(formatTokenCount(42_300)).toBe("42.3k")
  })

  it("formats exactly 1k", () => {
    expect(formatTokenCount(1_000)).toBe("1.0k")
  })

  it("formats small numbers as-is", () => {
    expect(formatTokenCount(999)).toBe("999")
  })

  it("formats zero", () => {
    expect(formatTokenCount(0)).toBe("0")
  })
})

// ── formatDuration ────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats milliseconds under 1 second", () => {
    expect(formatDuration(500)).toBe("500ms")
  })

  it("formats zero milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms")
  })

  it("formats seconds under 1 minute", () => {
    expect(formatDuration(5000)).toBe("5s")
  })

  it("formats exactly 1 second", () => {
    expect(formatDuration(1000)).toBe("1s")
  })

  it("formats minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s")
  })

  it("formats exact minutes with 0 seconds", () => {
    expect(formatDuration(120_000)).toBe("2m 0s")
  })

  it("rounds sub-second durations to nearest second", () => {
    expect(formatDuration(1500)).toBe("2s")
  })
})

// ── formatFileSize ────────────────────────────────────────────────────────

describe("formatFileSize", () => {
  it("formats megabytes", () => {
    expect(formatFileSize(2_500_000)).toBe("2.5MB")
  })

  it("formats exactly 1MB", () => {
    expect(formatFileSize(1_000_000)).toBe("1.0MB")
  })

  it("formats kilobytes", () => {
    expect(formatFileSize(42_000)).toBe("42KB")
  })

  it("formats exactly 1KB", () => {
    expect(formatFileSize(1_000)).toBe("1KB")
  })

  it("formats bytes", () => {
    expect(formatFileSize(500)).toBe("500B")
  })

  it("formats zero bytes", () => {
    expect(formatFileSize(0)).toBe("0B")
  })
})

// ── formatRelativeTime ────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns 'just now' for times less than 1 minute ago", () => {
    expect(formatRelativeTime("2025-01-15T11:59:30Z")).toBe("just now")
  })

  it("formats minutes ago", () => {
    expect(formatRelativeTime("2025-01-15T11:45:00Z")).toBe("15m ago")
  })

  it("formats 1 minute ago", () => {
    expect(formatRelativeTime("2025-01-15T11:59:00Z")).toBe("1m ago")
  })

  it("formats hours ago", () => {
    expect(formatRelativeTime("2025-01-15T09:00:00Z")).toBe("3h ago")
  })

  it("formats 1 hour ago", () => {
    expect(formatRelativeTime("2025-01-15T11:00:00Z")).toBe("1h ago")
  })

  it("formats days ago", () => {
    expect(formatRelativeTime("2025-01-13T12:00:00Z")).toBe("2d ago")
  })

  it("formats exactly 59 minutes ago as minutes", () => {
    expect(formatRelativeTime("2025-01-15T11:01:00Z")).toBe("59m ago")
  })

  it("formats exactly 60 minutes ago as 1h (boundary)", () => {
    expect(formatRelativeTime("2025-01-15T11:00:00Z")).toBe("1h ago")
  })

  it("formats exactly 23 hours ago as hours", () => {
    expect(formatRelativeTime("2025-01-14T13:00:00Z")).toBe("23h ago")
  })

  it("formats exactly 24 hours ago as 1d (boundary)", () => {
    expect(formatRelativeTime("2025-01-14T12:00:00Z")).toBe("1d ago")
  })

  it("formats exactly 6 days ago as days", () => {
    expect(formatRelativeTime("2025-01-09T12:00:00Z")).toBe("6d ago")
  })

  it("formats exactly 7 days ago as locale date (boundary)", () => {
    const result = formatRelativeTime("2025-01-08T12:00:00Z")
    expect(result).not.toContain("ago")
    expect(result).not.toBe("just now")
  })

  it("formats locale date for times older than 7 days", () => {
    const result = formatRelativeTime("2025-01-01T00:00:00Z")
    // Should call toLocaleDateString, exact format varies by locale
    expect(result).not.toContain("ago")
    expect(result).not.toBe("just now")
  })
})

// ── truncate ──────────────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns string unchanged if within max", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  it("returns string unchanged if exactly at max", () => {
    expect(truncate("hello", 5)).toBe("hello")
  })

  it("truncates and adds ellipsis when over max", () => {
    expect(truncate("hello world", 5)).toBe("hello...")
  })

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("")
  })

  it("handles max of 0", () => {
    expect(truncate("hello", 0)).toBe("...")
  })
})

// ── calculateTurnCost ─────────────────────────────────────────────────────

describe("calculateTurnCost", () => {
  it("calculates cost for opus model", () => {
    const cost = calculateTurnCost("claude-opus-4-6-20250115", 1_000_000, 1_000_000, 0, 0)
    // 1M input * $15/M + 1M output * $75/M = 15 + 75 = $90
    expect(cost).toBeCloseTo(90)
  })

  it("calculates cost for sonnet model", () => {
    const cost = calculateTurnCost("claude-sonnet-4-5-20250101", 1_000_000, 1_000_000, 0, 0)
    // 1M input * $3/M + 1M output * $15/M = 3 + 15 = $18
    expect(cost).toBeCloseTo(18)
  })

  it("calculates cost for haiku model", () => {
    const cost = calculateTurnCost("claude-haiku-4-5-20250101", 1_000_000, 1_000_000, 0, 0)
    // 1M input * $0.8/M + 1M output * $4/M = 0.8 + 4 = $4.8
    expect(cost).toBeCloseTo(4.8)
  })

  it("includes cache creation cost", () => {
    const cost = calculateTurnCost("claude-opus-4-6-20250115", 0, 0, 1_000_000, 0)
    // 1M cache write * $18.75/M = $18.75
    expect(cost).toBeCloseTo(18.75)
  })

  it("includes cache read cost", () => {
    const cost = calculateTurnCost("claude-opus-4-6-20250115", 0, 0, 0, 1_000_000)
    // 1M cache read * $1.5/M = $1.5
    expect(cost).toBeCloseTo(1.5)
  })

  it("uses default opus pricing for unknown models", () => {
    const cost = calculateTurnCost("unknown-model", 1_000_000, 0, 0, 0)
    // Falls back to opus pricing: 1M * $15/M = $15
    expect(cost).toBeCloseTo(15)
  })

  it("handles null model", () => {
    const cost = calculateTurnCost(null, 1_000_000, 0, 0, 0)
    expect(cost).toBeCloseTo(15)
  })

  it("returns 0 for zero tokens", () => {
    expect(calculateTurnCost("claude-opus-4-6-20250115", 0, 0, 0, 0)).toBe(0)
  })

  it("calculates combined cost with all token types", () => {
    // Opus: 100k input, 10k output, 50k cache write, 200k cache read
    const cost = calculateTurnCost(
      "claude-opus-4-6-20250115",
      100_000, 10_000, 50_000, 200_000
    )
    const expected =
      (100_000 / 1_000_000) * 15 +
      (10_000 / 1_000_000) * 75 +
      (50_000 / 1_000_000) * 18.75 +
      (200_000 / 1_000_000) * 1.5
    expect(cost).toBeCloseTo(expected)
  })

  it("differentiates opus 4.0 from sonnet 4.0 pricing", () => {
    const opusCost = calculateTurnCost("claude-opus-4-0-20250101", 1_000_000, 0, 0, 0)
    const sonnetCost = calculateTurnCost("claude-sonnet-4-0-20250101", 1_000_000, 0, 0, 0)
    expect(opusCost).toBe(15) // opus input = $15/M
    expect(sonnetCost).toBe(3) // sonnet input = $3/M
    expect(opusCost).toBeGreaterThan(sonnetCost)
  })
})

// ── formatCost ────────────────────────────────────────────────────────────

describe("formatCost", () => {
  it("formats costs under $0.01 with 4 decimal places", () => {
    expect(formatCost(0.0012)).toBe("$0.0012")
  })

  it("formats costs under $1 with 3 decimal places", () => {
    expect(formatCost(0.123)).toBe("$0.123")
  })

  it("formats costs at $1 or more with 2 decimal places", () => {
    expect(formatCost(12.345)).toBe("$12.35")
  })

  it("formats exactly $0.01", () => {
    expect(formatCost(0.01)).toBe("$0.010")
  })

  it("formats exactly $1", () => {
    expect(formatCost(1)).toBe("$1.00")
  })

  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.0000")
  })
})

// ── getContextLimit ───────────────────────────────────────────────────────

describe("getContextLimit", () => {
  it("returns 200k for opus models", () => {
    expect(getContextLimit("claude-opus-4-6")).toBe(200_000)
  })

  it("returns 200k for sonnet models", () => {
    expect(getContextLimit("claude-sonnet-4-5")).toBe(200_000)
  })

  it("returns 200k for haiku models", () => {
    expect(getContextLimit("claude-haiku-4-5")).toBe(200_000)
  })

  it("returns 200k for unknown models (default)", () => {
    expect(getContextLimit("gpt-4")).toBe(200_000)
  })
})

// ── getContextUsage ───────────────────────────────────────────────────────

describe("getContextUsage", () => {
  it("returns null for empty array", () => {
    expect(getContextUsage([])).toBeNull()
  })

  it("returns null when no assistant messages exist", () => {
    const msgs: RawMessage[] = [
      { type: "user", message: { role: "user", content: "hi" } } as RawMessage,
    ]
    expect(getContextUsage(msgs)).toBeNull()
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
    const result = getContextUsage([msg])
    expect(result).not.toBeNull()
    // used = 50000 + 10000 + 5000 = 65000
    expect(result!.used).toBe(65_000)
    expect(result!.limit).toBe(200_000)
    // compactAt = 200000 - 33000 = 167000
    expect(result!.compactAt).toBe(167_000)
    // percent = (65000 / 167000) * 100
    expect(result!.percent).toBeCloseTo((65_000 / 167_000) * 100, 1)
    expect(result!.percentAbsolute).toBeCloseTo((65_000 / 200_000) * 100, 1)
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
    const result = getContextUsage([msg1, msg2])
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
        usage: { input_tokens: 199_000, output_tokens: 0 },
      },
    })
    const result = getContextUsage([msg])
    // used=199000, compactAt=167000 => percent > 100, should cap
    expect(result!.percent).toBe(100)
    expect(result!.percentAbsolute).toBeCloseTo((199_000 / 200_000) * 100, 1)
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
    const result = getContextUsage([msg])
    expect(result!.used).toBe(30_000)
  })

  it("computes exact percent at compactAt boundary", () => {
    // compactAt = 200000 - 33000 = 167000
    const msg = assistantMsg([{ type: "text", text: "boundary" }], {
      message: {
        model: "claude-opus-4-6-20250115",
        id: "msg_boundary",
        role: "assistant",
        content: [{ type: "text", text: "boundary" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 167_000, output_tokens: 0 },
      },
    })
    const result = getContextUsage([msg])
    // used = 167000, compactAt = 167000 => exactly 100%
    expect(result!.percent).toBe(100)
    expect(result!.percentAbsolute).toBeCloseTo((167_000 / 200_000) * 100, 1)
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
    const result = getContextUsage([msg])
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
    const result = getContextUsage([assistantRaw, userRaw, systemRaw])
    // Should find the assistant message
    expect(result!.used).toBe(40_000)
  })
})
