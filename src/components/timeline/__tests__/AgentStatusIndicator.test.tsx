import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SessionProvider,
  type SessionChatContextValue,
  type SessionContextValue,
} from "@/contexts/SessionContext"
import { StreamingOverlayProvider } from "@/contexts/StreamingOverlayContext"
import { EMPTY_OVERLAY } from "@/lib/streamingOverlay"
import type { ParsedSession } from "../../../../shared/session/types"
import { AgentStatusIndicator, LiveElapsed } from "../AgentStatusIndicator"
import { registerSignInRunner } from "@/lib/agents/signIn"

interface MockSession {
  rawMessages: Array<Record<string, unknown>>
  turns: []
  sessionId?: string
}

function completedSession(): MockSession {
  return {
    rawMessages: [
      { type: "user" },
      { type: "assistant", message: { stop_reason: "end_turn" } },
    ],
    turns: [],
  }
}

function awaitingAgentsSession(): MockSession {
  return {
    rawMessages: [
      { type: "user", message: { role: "user", content: "go" } },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Async agent launched successfully." }] },
        toolUseResult: { status: "async_launched", agentId: "ag1", description: "Explore the parser" },
      },
      { type: "assistant", message: { stop_reason: "end_turn" } },
    ],
    turns: [],
  }
}

function agentLaunch(toolUseId: string, agentId: string, description: string) {
  return {
    type: "user",
    timestamp: "2026-10-14T10:00:00.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Async agent launched successfully." }] },
    toolUseResult: { status: "async_launched", agentId, description },
  }
}

function agentBatchSession(): MockSession {
  return {
    rawMessages: [
      { type: "user", message: { role: "user", content: "go" } },
      agentLaunch("tu1", "ag1", "Read the parser"),
      agentLaunch("tu2", "ag2", "Read the renderer"),
      { type: "assistant", message: { stop_reason: "end_turn" } },
      { type: "user", message: { role: "user", content: "<task-notification>\n<task-id>ag1</task-id>\n</task-notification>" } },
      { type: "assistant", message: { stop_reason: "end_turn" } },
    ],
    turns: [],
  }
}

function thinkingSession(): MockSession {
  return {
    rawMessages: [
      { type: "assistant", message: { stop_reason: null } },
    ],
    turns: [],
  }
}

const unusedChatContext = {} as SessionChatContextValue

function indicatorWithContext({
  session = completedSession(),
  isLive = true,
  isCompacting = false,
  pendingInteraction = null,
  agentProgress,
  dirName,
}: {
  session?: MockSession
  isLive?: boolean
  isCompacting?: boolean
  pendingInteraction?: SessionContextValue["pendingInteraction"]
  agentProgress?: Record<string, string>
  dirName?: string
} = {}) {
  const value = {
    session: session as unknown as ParsedSession,
    sessionSource: dirName ? { dirName, fileName: "s.jsonl", watchOffset: 0, loadId: 1 } : null,
    isLive,
    sseState: "connected",
    isCompacting,
    pendingInteraction,
  } as SessionContextValue

  return (
    <SessionProvider value={value} chatValue={unusedChatContext}>
      <StreamingOverlayProvider value={EMPTY_OVERLAY} agentProgress={agentProgress}>
        <AgentStatusIndicator />
      </StreamingOverlayProvider>
    </SessionProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("AgentStatusIndicator pending interaction", () => {
  it("surfaces a blocked question even though live traffic has stopped", () => {
    // A session blocked on AskUserQuestion emits no traffic, so isLive is false
    // and the derived status is idle — the indicator rendered nothing and the
    // session looked finished while it was actually waiting on the user.
    render(indicatorWithContext({
      isLive: false,
      pendingInteraction: {
        type: "question",
        toolUseId: "toolu_1",
        questions: [{ question: "Which one?", options: [{ label: "A" }] }],
      },
    }))

    expect(screen.getByText("Waiting for your answer")).toBeInTheDocument()
  })

  it("surfaces a blocked plan approval", () => {
    render(indicatorWithContext({
      isLive: false,
      pendingInteraction: { type: "plan" },
    }))

    expect(screen.getByText("Waiting for plan approval")).toBeInTheDocument()
  })
})

describe("AgentStatusIndicator lifecycle", () => {
  it("suppresses a completion carried into a new live turn until activity starts", () => {
    const view = render(indicatorWithContext({ isLive: false }))

    expect(screen.queryByText("Done")).not.toBeInTheDocument()

    view.rerender(indicatorWithContext())

    expect(screen.queryByText("Done")).not.toBeInTheDocument()

    view.rerender(indicatorWithContext({ session: thinkingSession() }))

    expect(screen.getByText("Thinking...")).toBeInTheDocument()

    view.rerender(indicatorWithContext())

    expect(screen.getByText("Done")).toBeInTheDocument()
  })

  it("keeps completion visible through the fade delay, then settles into the ready line", () => {
    vi.useFakeTimers()
    render(indicatorWithContext())

    expect(screen.getByText("Done")).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText("Done")).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(600))
    expect(screen.queryByText("Done")).not.toBeInTheDocument()
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument()
  })

  it("keeps the ready line visible after live traffic decays", () => {
    vi.useFakeTimers()
    const view = render(indicatorWithContext({ session: thinkingSession() }))
    view.rerender(indicatorWithContext())

    act(() => vi.advanceTimersByTime(2_600))
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument()

    // The SSE stale timer flipping isLive off must not hide the answer to
    // "is the agent waiting on me?" — that quiet stretch is exactly when
    // the user comes back to look.
    view.rerender(indicatorWithContext({ isLive: false }))
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument()
  })

  it("does not leak the ready latch into a different session", () => {
    vi.useFakeTimers()
    const live = { ...completedSession(), sessionId: "session-a" }
    const view = render(indicatorWithContext({ session: { ...thinkingSession(), sessionId: "session-a" } }))
    view.rerender(indicatorWithContext({ session: live }))
    act(() => vi.advanceTimersByTime(2_600))
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument()

    // Switching to a long-finished session must render nothing — its
    // completion was never witnessed live in this view.
    const archived = { ...completedSession(), sessionId: "session-b" }
    view.rerender(indicatorWithContext({ session: archived, isLive: false }))
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument()
    expect(screen.queryByText("Done")).not.toBeInTheDocument()
  })

  it("shows waiting-on-agents instead of Done while background agents run", () => {
    render(indicatorWithContext({ session: awaitingAgentsSession() }))

    expect(screen.getByText("Waiting on 1 agent")).toBeInTheDocument()
    expect(screen.getByText("Explore the parser")).toBeInTheDocument()
    expect(screen.queryByText("Done")).not.toBeInTheDocument()
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument()
  })

  it("lists every agent in the batch with how many have finished", () => {
    render(indicatorWithContext({ session: agentBatchSession() }))

    expect(screen.getByText("Waiting on 1 of 2 agents")).toBeInTheDocument()
    expect(screen.getByText("Read the parser").closest("li")).toHaveAttribute("data-agent-done", "true")
    expect(screen.getByText("Read the renderer").closest("li")).not.toHaveAttribute("data-agent-done")
  })

  it("shows a running agent's live progress line", () => {
    render(indicatorWithContext({
      session: agentBatchSession(),
      agentProgress: { tu1: "Stale line for a finished agent", tu2: "Tracing the virtualized list" },
    }))

    expect(screen.getByText("Tracing the virtualized list")).toBeInTheDocument()
    expect(screen.queryByText("Stale line for a finished agent")).not.toBeInTheDocument()
  })

  it("times the wait from the batch's first launch", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-14T10:01:30.000Z"))
    render(indicatorWithContext({ session: agentBatchSession() }))

    expect(within(screen.getByRole("button", { name: /Waiting on 1 of 2 agents/ })).getByText("1m 30s")).toBeInTheDocument()
  })

  it("collapses the agent list from its header", () => {
    render(indicatorWithContext({ session: agentBatchSession() }))

    fireEvent.click(screen.getByRole("button", { name: /Waiting on 1 of 2 agents/ }))

    expect(screen.queryByText("Read the renderer")).not.toBeInTheDocument()
    expect(screen.getByText("Waiting on 1 of 2 agents")).toBeInTheDocument()
  })

  it("continues to surface compaction while ordinary live output is paused", () => {
    render(indicatorWithContext({ isLive: false, isCompacting: true }))

    expect(screen.getByText("Compressing context...")).toBeInTheDocument()
  })

  it("restarts the elapsed clock immediately when the turn timestamp changes", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-21T10:00:10.000Z"))
    const view = render(<LiveElapsed startTimestamp="2026-07-21T10:00:00.000Z" />)

    expect(screen.getByText("10s")).toBeInTheDocument()

    vi.setSystemTime(new Date("2026-07-21T10:00:20.000Z"))
    view.rerender(<LiveElapsed startTimestamp="2026-07-21T10:00:19.000Z" />)

    expect(screen.getByText("1s")).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText("2s")).toBeInTheDocument()
  })
})

describe("AgentStatusIndicator failed turns", () => {
  const failedWith = (failureRecord: Record<string, unknown>): MockSession => ({
    rawMessages: [{ type: "user", message: { role: "user", content: "hi" } }, failureRecord],
    turns: [],
  })
  const apiError = (error: string, status: number, text: string) => ({
    type: "assistant", error, isApiErrorMessage: true, apiErrorStatus: status,
    message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text }] },
  })

  it("asks to sign in instead of thinking forever, even on a session opened later", () => {
    render(indicatorWithContext({ isLive: false, session: failedWith(apiError("authentication_failed", 401, "Not logged in · Please run /login")) }))
    expect(screen.getByRole("alert")).toHaveTextContent("Claude Code isn't signed in.")
    expect(screen.getByText("It said: Not logged in · Please run /login")).toBeInTheDocument()
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument()
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument()
  })

  it("signs in the account instance the session runs under", () => {
    const runner = vi.fn()
    const unregister = registerSignInRunner(runner)
    render(indicatorWithContext({ session: failedWith(apiError("authentication_failed", 401, "Not logged in")), dirName: "instance__work__-workspace" }))
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(runner).toHaveBeenCalledWith({ target: { kind: "claude", instanceId: "work" }, name: "Sign in to Claude Code" })
    unregister()
  })

  it("shows any other API error in red, not as a finished turn", () => {
    render(indicatorWithContext({ session: failedWith(apiError("rate_limit", 429, "API Error: Rate limited")) }))
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code stopped with an error.API Error: Rate limited")
    expect(document.querySelector("[data-agent-ready]")).toBeNull()
  })
})
