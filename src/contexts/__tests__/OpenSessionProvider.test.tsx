import { createRef } from "react"
import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import {
  OpenSessionProvider,
  useOpenSession,
  useSessionContext,
  useSessionControls,
  type ChatState,
  type ScrollState,
  type SessionControls,
} from "@/contexts/SessionContext"
import { createSessionStore } from "@/hooks/useSessionState"
import { makeTurn } from "@/__tests__/fixtures"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../../shared/session/sessionDigest"
import type { Turn } from "../../../shared/session/types"

function session(turns: Turn[]): SessionView {
  return {
    sessionId: "s1",
    version: "1",
    gitBranch: "main",
    cwd: "/repo",
    slug: "",
    name: "",
    model: "opus",
    turns,
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: turns.length,
    },
    digest: EMPTY_SESSION_DIGEST,
  }
}

const controls = { sessionSource: null, isLive: true } as unknown as SessionControls
const chat = { pendingMessages: [], consumePending: vi.fn() } as unknown as ChatState
const renders = { shell: 0, controls: 0, fact: 0, transcript: 0 }

/** Stands in for the activity bar, sidebar and panels: below the provider, reading nothing of the session. */
function Shell() {
  renders.shell++
  return <Controls />
}

function Controls() {
  renders.controls++
  useSessionControls()
  return <Fact />
}

function Fact() {
  renders.fact++
  const cwd = useOpenSession((open) => open?.cwd)
  return <span>{cwd}</span>
}

function Transcript() {
  renders.transcript++
  const { session: shown } = useSessionContext()
  return <span data-testid="turns">{shown?.turns.length}</span>
}

describe("OpenSessionProvider", () => {
  it("re-renders only what shows the session on a live batch, not the shell around it", () => {
    const store = createSessionStore()
    const scrollHandle = createRef<ScrollState>()
    const shown = vi.fn()
    Object.assign(renders, { shell: 0, controls: 0, fact: 0, transcript: 0 })
    render(
      <OpenSessionProvider store={store} controls={controls} chat={chat} isLive sessionChangeKey={0} scrollHandle={scrollHandle} onSessionShown={shown}>
        <Shell />
        <Transcript />
      </OpenSessionProvider>,
    )
    act(() => store.dispatch({ type: "LOAD_SESSION", session: session([makeTurn({ id: "t1" })]), source: { dirName: "d", fileName: "s1.jsonl", watchOffset: 0, loadId: 1 }, isMobile: false }))
    const before = { ...renders }

    const streamed = session([makeTurn({ id: "t1" }), makeTurn({ id: "t2" })])
    act(() => store.dispatch({ type: "UPDATE_SESSION", session: streamed }))

    expect(screen.getByTestId("turns")).toHaveTextContent("2")
    expect(renders.transcript).toBe(before.transcript + 1)
    expect(renders.shell).toBe(before.shell)
    expect(renders.controls).toBe(before.controls)
    expect(renders.fact).toBe(before.fact)
    // The overlay handoff runs in the commit that shows the batch.
    expect(shown).toHaveBeenLastCalledWith(streamed)
    expect(scrollHandle.current?.resetTurnCount).toBeTypeOf("function")
  })
})
