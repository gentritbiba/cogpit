import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { SessionStatusBar } from "../SessionStatusBar"
import type { ActiveSessionInfo } from "../LiveSessions/types"
import type { ParsedSession, Turn } from "@/lib/types"

const inventorySessions = vi.hoisted(() => ({ current: [] as ActiveSessionInfo[] }))

vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => ({ sessions: inventorySessions.current }),
}))

/** Stands in for the whole-file scan the server ships with the session list. */
function withScannedSession(sessionId: string, pullRequests: ActiveSessionInfo["pullRequests"]) {
  inventorySessions.current = [{
    dirName: "d",
    projectShortName: "P",
    fileName: "f.jsonl",
    sessionId,
    lastModified: "2026-08-14T10:00:00.000Z",
    size: 1,
    pullRequests,
  }]
}

function prTurn(id: string, command: string, result: string): Turn {
  return {
    id,
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [{
      id: `tool-${id}`,
      name: "Bash",
      input: { command },
      result,
      isError: false,
      timestamp: "2026-08-14T10:00:00.000Z",
    }],
    subAgentActivity: [],
    timestamp: "2026-08-14T10:00:00.000Z",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
}

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session-id",
    version: "1.0",
    gitBranch: "",
    cwd: "/home/user/project",
    slug: "test-slug",
    name: "",
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
    ...overrides,
  }
}

describe("SessionStatusBar", () => {
  beforeEach(() => { inventorySessions.current = [] })

  it("renders nothing when all optional values are absent and model/gitBranch are empty", () => {
    const { container } = render(
      <SessionStatusBar session={makeSession()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the general model family name when session.model is set", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} />
    )
    expect(screen.getByText("opus")).toBeInTheDocument()
  })

  it("renders effort with Zap icon text when effort prop is provided", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} effort="high" />
    )
    expect(screen.getByText("high")).toBeInTheDocument()
  })

  it("does not render effort section when effort prop is omitted", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} />
    )
    expect(screen.queryByText("high")).toBeNull()
  })

  it("renders 'thinking' label when thinkingEnabled is true", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} thinkingEnabled />
    )
    expect(screen.getByText("thinking")).toBeInTheDocument()
  })

  it("does not render 'thinking' label when thinkingEnabled is false", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} thinkingEnabled={false} />
    )
    expect(screen.queryByText("thinking")).toBeNull()
  })

  it("does not render 'thinking' label when thinkingEnabled is omitted", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} />
    )
    expect(screen.queryByText("thinking")).toBeNull()
  })

  it("renders worktreePath when provided", () => {
    render(
      <SessionStatusBar
        session={makeSession({ model: "claude-opus-4-5" })}
        worktreePath="/worktrees/fix-auth"
      />
    )
    expect(screen.getByText("/worktrees/fix-auth")).toBeInTheDocument()
  })

  it("does not render worktreePath section when omitted", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} />
    )
    expect(screen.queryByText("/worktrees/fix-auth")).toBeNull()
  })

  it("renders gitBranch when set on session", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5", gitBranch: "feat/my-feature" })} />
    )
    expect(screen.getByText("feat/my-feature")).toBeInTheDocument()
  })

  it("renders all fields together correctly", () => {
    render(
      <SessionStatusBar
        session={makeSession({ model: "claude-sonnet-4-6", gitBranch: "main" })}
        effort="medium"
        thinkingEnabled
        worktreePath="/worktrees/task-1"
      />
    )
    expect(screen.getByText("sonnet")).toBeInTheDocument()
    expect(screen.getByText("medium")).toBeInTheDocument()
    expect(screen.getByText("thinking")).toBeInTheDocument()
    expect(screen.getByText("/worktrees/task-1")).toBeInTheDocument()
    expect(screen.getByText("main")).toBeInTheDocument()
  })

  it("renders nothing when session has no model but gitBranch is also empty", () => {
    const { container } = render(
      <SessionStatusBar
        session={makeSession({ model: "", gitBranch: "" })}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the bar when only gitBranch is set", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "", gitBranch: "develop" })} />
    )
    expect(screen.getByText("develop")).toBeInTheDocument()
  })

  it("renders a pull request chip linking to the pull request", () => {
    render(
      <SessionStatusBar session={makeSession({
        turns: [prTurn("1", 'gh pr create --title "Team Edition"', "https://github.com/o/r/pull/13")],
      })} />
    )
    const link = screen.getByRole("link", { name: "Pull request #13" })
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/13")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveTextContent("#13")
    expect(link).toHaveAttribute("title", expect.stringContaining("Team Edition"))
  })

  it("renders the bar for pull requests even when every other field is empty", () => {
    render(
      <SessionStatusBar session={makeSession({
        turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/7")],
      })} />
    )
    expect(screen.getByRole("link", { name: "Pull request #7" })).toBeInTheDocument()
  })

  it("collapses older pull requests into a +N chip", () => {
    render(
      <SessionStatusBar session={makeSession({
        turns: [1, 2, 3, 4, 5].map((n) =>
          prTurn(String(n), "gh pr create --fill", `https://github.com/o/r/pull/${n}`)),
      })} />
    )
    expect(screen.getByText("+2")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pull request #5" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Pull request #1" })).toBeNull()
  })

  it("does not render pull request chips when the session opened none", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} />
    )
    expect(screen.queryByRole("link")).toBeNull()
  })
})

describe("SessionStatusBar — pull requests backfilled from the server scan", () => {
  const scanned = {
    url: "https://github.com/o/r/pull/777",
    number: 777,
    repo: "o/r",
    title: "Early pull request",
    isDraft: false,
    toolCallId: "toolu_early",
    timestamp: "2026-08-14T09:00:00.000Z",
  }

  beforeEach(() => { inventorySessions.current = [] })

  it("shows a pull request created before the loaded turns", () => {
    withScannedSession("test-session-id", [scanned])
    render(<SessionStatusBar session={makeSession({ turns: [] })} />)
    expect(screen.getByRole("link", { name: "Pull request #777" })).toBeInTheDocument()
  })

  it("ignores scan results belonging to a different session", () => {
    withScannedSession("some-other-session", [scanned])
    render(<SessionStatusBar session={makeSession({ turns: [] })} />)
    expect(screen.queryByRole("link", { name: "Pull request #777" })).toBeNull()
  })

  it("does not double up a pull request found by both the scan and the loaded turns", () => {
    withScannedSession("test-session-id", [{ ...scanned, number: 13, url: "https://github.com/o/r/pull/13" }])
    render(<SessionStatusBar session={makeSession({
      turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/13")],
    })} />)
    expect(screen.getAllByRole("link", { name: "Pull request #13" })).toHaveLength(1)
  })

  it("combines a scanned older pull request with a freshly created one", () => {
    withScannedSession("test-session-id", [scanned])
    render(<SessionStatusBar session={makeSession({
      turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/778")],
    })} />)
    expect(screen.getByRole("link", { name: "Pull request #777" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pull request #778" })).toBeInTheDocument()
  })
})
