import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { usePendingPrompts } from "../usePendingPrompts"
import { emptyTurn } from "@/__tests__/fixtures"
import type { ParsedSession } from "../../../shared/session/types"

function makeSession(turnCount: number): ParsedSession {
  return {
    sessionId: "s1",
    version: "1",
    gitBranch: "main",
    cwd: "/tmp",
    slug: "test",
    name: "",
    model: "opus",
    turns: Array.from({ length: turnCount }, (_, i) => emptyTurn({ id: `t${i}`, userMessage: `msg ${i}` })),
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount,
    },
    rawMessages: [],
  }
}

describe("usePendingPrompts", () => {
  const consumePending = vi.fn()
  const defaults = { session: null as ParsedSession | null, pendingMessages: [] as string[], consumePending }

  beforeEach(() => vi.clearAllMocks())

  it("consumes pending messages when new turns arrive", () => {
    const { rerender } = renderHook((props) => usePendingPrompts(props), {
      initialProps: { ...defaults, session: makeSession(1), pendingMessages: ["waiting..."] },
    })
    rerender({ ...defaults, session: makeSession(2), pendingMessages: ["waiting..."] })
    expect(consumePending).toHaveBeenCalledWith(1)
  })

  it("does not count turns the reset already accounted for", () => {
    const session = makeSession(3)
    const { result, rerender } = renderHook((props) => usePendingPrompts(props), {
      initialProps: { ...defaults, session },
    })
    act(() => result.current(3))
    rerender({ ...defaults, session, pendingMessages: ["waiting..."] })
    expect(consumePending).not.toHaveBeenCalled()
  })

  it("counts every turn as new after a reset to zero", () => {
    const session = makeSession(2)
    const { result, rerender } = renderHook((props) => usePendingPrompts(props), {
      initialProps: { ...defaults, session },
    })
    act(() => result.current(0))
    rerender({ ...defaults, session: makeSession(2), pendingMessages: ["a", "b", "c"] })
    expect(consumePending).toHaveBeenCalledWith(2)
  })

  it("replaces an optimistic preview when a queued Claude prompt is persisted", () => {
    const initial = makeSession(1)
    const { rerender } = renderHook((props) => usePendingPrompts(props), { initialProps: { ...defaults, session: initial } })
    rerender({ ...defaults, session: initial, pendingMessages: ["Also check the tests"] })
    expect(consumePending).not.toHaveBeenCalled()

    const persisted = makeSession(1)
    persisted.turns[0].contentBlocks.push({ kind: "queued_prompt", content: "Also check the tests", timestamp: "2025-01-15T10:00:01Z" })
    rerender({ ...defaults, session: persisted, pendingMessages: ["Also check the tests"] })
    expect(consumePending).toHaveBeenCalledWith(1)
  })

  it("does not consume a new preview because of historical queued prompts", () => {
    const session = makeSession(1)
    session.turns[0].contentBlocks.push({ kind: "queued_prompt", content: "An older prompt", timestamp: "2025-01-15T10:00:01Z" })
    const { rerender } = renderHook((props) => usePendingPrompts(props), { initialProps: { ...defaults, session } })
    rerender({ ...defaults, session, pendingMessages: ["A new prompt"] })
    expect(consumePending).not.toHaveBeenCalled()
  })

  it("does not consume a preview when a different queued prompt arrives externally", () => {
    const initial = makeSession(1)
    const { rerender } = renderHook((props) => usePendingPrompts(props), { initialProps: { ...defaults, session: initial } })
    rerender({ ...defaults, session: initial, pendingMessages: ["Dashboard prompt"] })

    const updated = makeSession(1)
    updated.turns[0].contentBlocks.push({ kind: "queued_prompt", content: "Prompt sent from another client", timestamp: "2025-01-15T10:00:01Z" })
    rerender({ ...defaults, session: updated, pendingMessages: ["Dashboard prompt"] })
    expect(consumePending).not.toHaveBeenCalled()
  })
})
