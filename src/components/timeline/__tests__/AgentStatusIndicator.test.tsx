import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SessionProvider,
  type SessionChatContextValue,
  type SessionContextValue,
} from "@/contexts/SessionContext"
import type { ParsedSession } from "@/lib/types"
import { AgentStatusIndicator, LiveElapsed } from "../AgentStatusIndicator"

interface MockSession {
  rawMessages: Array<{ type: string; message?: { stop_reason: string | null } }>
  turns: []
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
}: {
  session?: MockSession
  isLive?: boolean
  isCompacting?: boolean
  pendingInteraction?: SessionContextValue["pendingInteraction"]
} = {}) {
  const value = {
    session: session as unknown as ParsedSession,
    isLive,
    sseState: "connected",
    isCompacting,
    pendingInteraction,
  } as SessionContextValue

  return (
    <SessionProvider value={value} chatValue={unusedChatContext}>
      <AgentStatusIndicator />
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

  it("keeps completion visible through the fade delay, then hides it", () => {
    vi.useFakeTimers()
    render(indicatorWithContext())

    expect(screen.getByText("Done")).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText("Done")).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(600))
    expect(screen.queryByText("Done")).not.toBeInTheDocument()
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
