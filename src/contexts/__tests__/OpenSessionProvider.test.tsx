import { createRef, useLayoutEffect } from "react"
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
import { createSessionStore, type SessionStore } from "@/hooks/useSessionState"
import type { SessionSource } from "@/lib/sessionSource"
import { makeTurn } from "@/__tests__/fixtures"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../../shared/session/sessionDigest"
import type { Turn } from "../../../shared/session/types"

function session(turns: Turn[], sessionId = "s1"): SessionView {
  return {
    sessionId,
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

function source(fileName: string, loadId = 1): SessionSource {
  return { dirName: "d", fileName, watchOffset: 0, loadId }
}

function load(store: SessionStore, open: SessionView) {
  act(() => store.dispatch({ type: "LOAD_SESSION", session: open, source: source(`${open.sessionId}.jsonl`), isMobile: false }))
}

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
      <OpenSessionProvider store={store} controls={controls} chat={chat} isLive scrollHandle={scrollHandle} onSessionShown={shown}>
        <Shell />
        <Transcript />
      </OpenSessionProvider>,
    )
    act(() => store.dispatch({ type: "LOAD_SESSION", session: session([makeTurn({ id: "t1" })]), source: { dirName: "d", fileName: "s1.jsonl", watchOffset: 0, loadId: 1 }, isMobile: false }))
    const before = { ...renders }

    const streamed = session([makeTurn({ id: "t1" }), makeTurn({ id: "t2" })])
    act(() => store.dispatch({ type: "UPDATE_SESSION", loadId: 1, session: streamed }))

    expect(screen.getByTestId("turns")).toHaveTextContent("2")
    expect(renders.transcript).toBe(before.transcript + 1)
    expect(renders.shell).toBe(before.shell)
    expect(renders.controls).toBe(before.controls)
    expect(renders.fact).toBe(before.fact)
    // The overlay handoff runs in the commit that shows the batch.
    expect(shown).toHaveBeenLastCalledWith(streamed)
    expect(scrollHandle.current?.resetTurnCount).toBeTypeOf("function")
  })

  it("shows a batch after the urgent commit, so a click or the next batch can interrupt that render", () => {
    const store = createSessionStore()
    const shown = vi.fn()
    const seen: Array<[number | undefined, string | null]> = []
    // A fact reader commits with the store; its layout effect sees what the transcript shows then.
    function Probe() {
      const count = useOpenSession((open) => open?.turns.length)
      useLayoutEffect(() => { seen.push([count, screen.getByTestId("turns").textContent]) }, [count])
      return null
    }
    render(
      <OpenSessionProvider store={store} controls={controls} chat={chat} isLive onSessionShown={shown}>
        <Transcript />
        <Probe />
      </OpenSessionProvider>,
    )
    act(() => store.dispatch({ type: "LOAD_SESSION", session: session([makeTurn({ id: "t1" })]), source: { dirName: "d", fileName: "s1.jsonl", watchOffset: 0, loadId: 1 }, isMobile: false }))
    seen.length = 0

    const streamed = session([makeTurn({ id: "t1" }), makeTurn({ id: "t2" })])
    act(() => store.dispatch({ type: "UPDATE_SESSION", loadId: 1, session: streamed }))

    expect(seen).toEqual([[2, "1"]])
    expect(screen.getByTestId("turns")).toHaveTextContent("2")
    expect(shown).toHaveBeenLastCalledWith(streamed)
  })

  it("hands a switched-to session and its change key to the transcript together", () => {
    const store = createSessionStore()
    const pairs: Array<[string | undefined, number]> = []
    function Keyed() {
      const { session: open, sessionChangeKey } = useSessionContext()
      pairs.push([open?.sessionId, sessionChangeKey])
      return null
    }
    render(
      <OpenSessionProvider store={store} controls={controls} chat={chat} isLive>
        <Keyed />
      </OpenSessionProvider>,
    )
    for (const id of ["s1", "s2"]) {
      act(() => store.dispatch({ type: "LOAD_SESSION", session: session([makeTurn({ id: "t1" })], id), source: { dirName: "d", fileName: `${id}.jsonl`, watchOffset: 0, loadId: 1 }, isMobile: false }))
    }

    expect(pairs).toEqual([[undefined, 0], ["s1", 1], ["s2", 2]])
  })

  it("hands the focused turn over with the turns it counts, so a page in front never points it at another turn (review 3 #1)", () => {
    const store = createSessionStore()
    const focused: Array<string | undefined> = []
    function Ring() {
      const { session: open, activeTurnIndex } = useSessionContext()
      if (activeTurnIndex !== null) focused.push(open?.turns[activeTurnIndex]?.id)
      return null
    }
    render(
      <OpenSessionProvider store={store} controls={controls} chat={chat} isLive>
        <Ring />
      </OpenSessionProvider>,
    )
    load(store, session([makeTurn({ id: "t1" }), makeTurn({ id: "t2" })]))
    act(() => store.dispatch({ type: "JUMP_TO_TURN", index: 1 }))
    act(() => store.dispatch({ type: "SET_OLDER_TURNS", turns: [makeTurn({ id: "t-1" }), makeTurn({ id: "t0" })] }))

    expect(store.getState().activeTurnIndex).toBe(3)
    expect(focused.length).toBeGreaterThan(1)
    expect(new Set(focused)).toEqual(new Set(["t2"]))
  })
})
