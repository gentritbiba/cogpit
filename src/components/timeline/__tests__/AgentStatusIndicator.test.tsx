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
}: {
  session?: MockSession
  isLive?: boolean
  isCompacting?: boolean
} = {}) {
  const value = {
    session: session as unknown as ParsedSession,
    isLive,
    sseState: "connected",
    isCompacting,
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
