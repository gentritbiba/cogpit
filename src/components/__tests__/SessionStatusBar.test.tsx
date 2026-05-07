import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { SessionStatusBar } from "../SessionStatusBar"
import type { ParsedSession } from "@/lib/types"

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
  it("renders nothing when all optional values are absent and model/gitBranch are empty", () => {
    const { container } = render(
      <SessionStatusBar session={makeSession()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders model name when session.model is set", () => {
    render(
      <SessionStatusBar session={makeSession({ model: "claude-opus-4-5" })} />
    )
    expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument()
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
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument()
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
})
