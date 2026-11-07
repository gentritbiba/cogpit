import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  dirNameToPath,
  shortenModel,
  formatTokenCount,
  formatDuration,
  formatFileSize,
  formatRelativeTime,
  truncate,
  formatCost,
  getContextLimit,
  parseWorktreePath,
  getTurnDuration,
} from "@/lib/format"
import { makeTurn, makeToolCall, resetFixtureCounter } from "@/__tests__/fixtures"

beforeEach(() => {
  resetFixtureCounter()
})

// ── shortenModel ──────────────────────────────────────────────────────────

describe("shortenModel", () => {
  it("returns 'unknown' for empty string", () => {
    expect(shortenModel("")).toBe("unknown")
  })

  it("keeps the version and 1M context marker for fable ids", () => {
    expect(shortenModel("claude-fable-5")).toBe("Fable 5")
    expect(shortenModel("claude-fable-5-1")).toBe("Fable 5.1")
    expect(shortenModel("claude-fable-5[1m]")).toBe("Fable 5 1M")
  })

  it("keeps the version for opus ids and drops the date suffix", () => {
    expect(shortenModel("claude-opus-4-8")).toBe("Opus 4.8")
    expect(shortenModel("claude-opus-4-6-20250115")).toBe("Opus 4.6")
    expect(shortenModel("claude-opus-5")).toBe("Opus 5")
    expect(shortenModel("claude-opus-future")).toBe("Opus")
  })

  it("handles sonnet and haiku ids the same way", () => {
    expect(shortenModel("claude-sonnet-4-6-20250115")).toBe("Sonnet 4.6")
    expect(shortenModel("claude-sonnet-5")).toBe("Sonnet 5")
    expect(shortenModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5")
    expect(shortenModel("claude-haiku-future")).toBe("Haiku")
  })

  it("capitalizes bare CLI aliases", () => {
    expect(shortenModel("opus")).toBe("Opus")
    expect(shortenModel("opus[1m]")).toBe("Opus 1M")
  })

  it("formats GPT ids with their variant", () => {
    expect(shortenModel("gpt-5.6-sol")).toBe("GPT-5.6 Sol")
    expect(shortenModel("gpt-5.4-mini")).toBe("GPT-5.4 Mini")
    expect(shortenModel("gpt-5.3-codex-spark")).toBe("GPT-5.3 Codex Spark")
    expect(shortenModel("gpt-4o")).toBe("GPT-4o")
  })

  it("truncates long unknown model names", () => {
    const longName = "some-very-long-model-name-that-exceeds-twenty-chars"
    expect(shortenModel(longName)).toBe("some-very-long-model...")
  })

  it("returns short unknown model names as-is", () => {
    expect(shortenModel("<synthetic>")).toBe("<synthetic>")
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

  it("switches to hours past the hour mark", () => {
    // Agent sessions routinely run for hours, and "885m 12s" is unreadable.
    expect(formatDuration(3_600_000)).toBe("1h 0m")
    expect(formatDuration(3_840_000)).toBe("1h 4m")
    expect(formatDuration(53_112_000)).toBe("14h 45m")
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
    expect(formatRelativeTime("2025-01-15T11:59:30Z")).toBe("now")
  })

  it("formats minutes ago", () => {
    expect(formatRelativeTime("2025-01-15T11:45:00Z")).toBe("15m")
  })

  it("formats 1 minute ago", () => {
    expect(formatRelativeTime("2025-01-15T11:59:00Z")).toBe("1m")
  })

  it("formats hours ago", () => {
    expect(formatRelativeTime("2025-01-15T09:00:00Z")).toBe("3h")
  })

  it("formats 1 hour / the 60-minute boundary as 1h", () => {
    expect(formatRelativeTime("2025-01-15T11:00:00Z")).toBe("1h")
  })

  it("formats days ago", () => {
    expect(formatRelativeTime("2025-01-13T12:00:00Z")).toBe("2d")
  })

  it("formats exactly 59 minutes ago as minutes", () => {
    expect(formatRelativeTime("2025-01-15T11:01:00Z")).toBe("59m")
  })

  it("formats exactly 23 hours ago as hours", () => {
    expect(formatRelativeTime("2025-01-14T13:00:00Z")).toBe("23h")
  })

  it("formats exactly 24 hours ago as 1d (boundary)", () => {
    expect(formatRelativeTime("2025-01-14T12:00:00Z")).toBe("1d")
  })

  it("formats exactly 6 days ago as days", () => {
    expect(formatRelativeTime("2025-01-09T12:00:00Z")).toBe("6d")
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

  it("renders non-finite costs as a dash", () => {
    // Callers divide a session cost by a count, so 0/0 and x/0 both reach here.
    expect(formatCost(Number.NaN)).toBe("—")
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("—")
    expect(formatCost(Number.NEGATIVE_INFINITY)).toBe("—")
    expect(formatCost(0 / 0)).toBe("—")
    expect(formatCost(1 / 0)).toBe("—")
  })
})

// ── getContextLimit ───────────────────────────────────────────────────────

// Per-model behaviour is owned by src/lib/__tests__/contextWindow.test.ts;
// format.ts only re-exports the helper, so this pins the re-export itself.
describe("getContextLimit", () => {
  it("re-exports the shared context-limit helper", () => {
    expect(getContextLimit("claude-opus-5", "claude")).toBe(1_000_000)
    expect(getContextLimit("claude-haiku-4-5", "claude")).toBe(200_000)
  })
})

// ── parseWorktreePath ────────────────────────────────────────────────────

describe("parseWorktreePath", () => {
  it("returns null for a regular project path", () => {
    expect(parseWorktreePath("/Users/user/code/my-project")).toBeNull()
  })

  it("parses a worktree path and extracts parent + name", () => {
    const result = parseWorktreePath("/Users/user/code/my-project/.worktrees/feature-branch")
    expect(result).toEqual({
      parentPath: "/Users/user/code/my-project",
      worktreeName: "feature-branch",
    })
  })

  it("handles worktree paths with trailing segments", () => {
    const result = parseWorktreePath("/Users/user/code/project/.worktrees/fix-bug/src/index.ts")
    expect(result).toEqual({
      parentPath: "/Users/user/code/project",
      worktreeName: "fix-bug",
    })
  })

  it("parses Claude Code's .claude/worktrees layout", () => {
    expect(parseWorktreePath("/Users/user/code/project/.claude/worktrees/inventory-admin")).toEqual({
      parentPath: "/Users/user/code/project",
      worktreeName: "inventory-admin",
    })
  })

  it("parses Windows separators", () => {
    expect(parseWorktreePath("C:\\code\\project\\.claude\\worktrees\\fix")).toEqual({
      parentPath: "C:\\code\\project",
      worktreeName: "fix",
    })
  })

  it("returns null for other folders named worktrees", () => {
    expect(parseWorktreePath("/Users/user/code/worktrees/fix")).toBeNull()
    expect(parseWorktreePath("/Users/user/.claude/projects/worktrees")).toBeNull()
  })

  it("returns null when .worktrees is not preceded by /", () => {
    expect(parseWorktreePath("/Users/user/.worktrees-backup/foo")).toBeNull()
  })

  it("returns null for path ending at /.worktrees/ with no name", () => {
    expect(parseWorktreePath("/Users/user/project/.worktrees/")).toBeNull()
  })
})

describe("getTurnDuration", () => {
  it("prefers the duration Claude Code reported", () => {
    expect(getTurnDuration(makeTurn({ durationMs: 4200 }))).toBe(4200)
  })

  it("falls back to the span of the turn's own timestamps", () => {
    const turn = makeTurn({
      durationMs: null,
      timestamp: "2025-01-15T10:00:00Z",
      contentBlocks: [{ kind: "text", text: ["done"], timestamp: "2025-01-15T10:00:30Z" }],
    })
    expect(getTurnDuration(turn)).toBe(30_000)
  })

  it("counts tool calls that outlast their block", () => {
    const turn = makeTurn({
      durationMs: null,
      timestamp: "2025-01-15T10:00:00Z",
      contentBlocks: [{
        kind: "tool_calls",
        timestamp: "2025-01-15T10:00:05Z",
        toolCalls: [makeToolCall({ timestamp: "2025-01-15T10:00:20Z" })],
      }],
    })
    expect(getTurnDuration(turn)).toBe(20_000)
  })

  it("bills the stretches a resumed turn worked, not the wait between them", () => {
    // 10s of work, an hour idle waiting on a background task, then 5s more.
    const turn = makeTurn({
      durationMs: null,
      timestamp: "2025-01-15T10:00:00Z",
      contentBlocks: [
        { kind: "text", text: ["waiting on CI"], timestamp: "2025-01-15T10:00:10Z" },
        { kind: "task_notification", content: "<task-notification></task-notification>", timestamp: "2025-01-15T11:00:10Z" },
        { kind: "text", text: ["merged"], timestamp: "2025-01-15T11:00:15Z" },
      ],
    })
    expect(getTurnDuration(turn)).toBe(15_000)
  })

  it("returns null when nothing in the turn is timestamped", () => {
    expect(getTurnDuration(makeTurn({ durationMs: null, contentBlocks: [] }))).toBeNull()
  })
})

describe("dirNameToPath", () => {
  // The dash-separated decoder used to run against every dirName, so a base64
  // project name came back as a plausible-looking path that pointed nowhere.
  it("decodes each agent's own project directory encoding", () => {
    expect(dirNameToPath("-Users-me-proj")).toBe("/Users/me/proj")
    expect(dirNameToPath("codex__L3RtcC9wcm9qZWN0")).toBe("/tmp/project")
    expect(dirNameToPath("copilot__L3RtcC9wcm9qZWN0")).toBe("/tmp/project")
  })

  it("falls back to the directory name when the payload cannot be decoded", () => {
    expect(dirNameToPath("codex__!!!not-base64!!!")).toBe("codex__!!!not-base64!!!")
  })
})
