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

const controls = { sessionSource: null, isLive: true, undoRedo: { enabled: false, requestUndo: vi.fn() }, actions: {} } as unknown as SessionControls
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

  it("shows a session opened onto an empty screen in the commit that opens it", () => {
    const store = createSessionStore()
    const seen: Array<string | undefined> = []
    function Probe() {
      const id = useOpenSession((open) => open?.sessionId)
      useLayoutEffect(() => { seen.push(screen.getByTestId("turns").textContent ?? undefined) }, [id])
      return null
    }
    render(
      <OpenSessionProvider store={store} controls={controls} chat={chat} isLive>
        <Transcript />
        <Probe />
      </OpenSessionProvider>,
    )
    seen.length = 0
    load(store, session([makeTurn({ id: "t1" })]))
    expect(seen).toEqual(["1"])
  })

  it("pairs the source with the session it shows", () => {
    const store = createSessionStore()
    const pairs: Array<[string | undefined, string | undefined]> = []
    function Paired() {
      const { session: open, sessionSource } = useSessionContext()
      pairs.push([open?.sessionId, sessionSource?.fileName])
      return null
    }
    render(
      <OpenSessionProvider store={store} controls={controls} chat={chat} isLive>
        <Paired />
      </OpenSessionProvider>,
    )
    load(store, session([makeTurn({ id: "a1" })], "a"))
    load(store, session([makeTurn({ id: "b1" })], "b"))
    expect(pairs.filter(([id, file]) => id !== undefined && `${id}.jsonl` !== file)).toEqual([])
    expect(pairs.at(-1)).toEqual(["b", "b.jsonl"])
  })

  describe("actions a row takes with its index (review 3 #2)", () => {
    function setup() {
      const store = createSessionStore()
      const requestUndo = vi.fn()
      const handleOpenBranches = vi.fn()
      const handleBranchFromHere = vi.fn()
      const actionControls = {
        ...controls,
        undoRedo: { enabled: true, requestUndo },
        actions: { handleOpenBranches, handleBranchFromHere },
      } as unknown as SessionControls
      let row!: Pick<SessionControls, "undoRedo" | "actions">
      function Row() {
        row = useSessionContext()
        return null
      }
      render(
        <OpenSessionProvider store={store} controls={actionControls} chat={chat} isLive>
          <Row />
        </OpenSessionProvider>,
      )
      return { store, row: () => row, requestUndo, handleOpenBranches, handleBranchFromHere }
    }

    it("acts on the turn the row shows when pages went in front of it before the screen caught up", () => {
      const { store, row, requestUndo, handleOpenBranches, handleBranchFromHere } = setup()
      load(store, session([makeTurn({ id: "t1" }), makeTurn({ id: "t2" })]))
      const onScreen = row()

      act(() => {
        store.dispatch({ type: "SET_OLDER_TURNS", turns: [makeTurn({ id: "t-1" }), makeTurn({ id: "t0" })] })
        // The click lands before the deferred render shows the pages.
        onScreen.undoRedo.requestUndo(1)
        onScreen.actions.handleOpenBranches?.(1)
        onScreen.actions.handleBranchFromHere?.(0)
      })
      expect(requestUndo).toHaveBeenCalledWith(3)
      expect(handleOpenBranches).toHaveBeenCalledWith(3)
      expect(handleBranchFromHere).toHaveBeenCalledWith(2)

      // Once the pages are on screen, the row's index is the store's.
      row().undoRedo.requestUndo(3)
      expect(requestUndo).toHaveBeenLastCalledWith(3)
    })

    it("acts on the turn the row shows when a live batch added turns behind it", () => {
      const { store, row, requestUndo } = setup()
      load(store, session([makeTurn({ id: "t1" }), makeTurn({ id: "t2" })]))
      const onScreen = row()
      act(() => {
        store.dispatch({ type: "UPDATE_SESSION", loadId: 1, session: session([makeTurn({ id: "t1" }), makeTurn({ id: "t2" }), makeTurn({ id: "t3" })]) })
        onScreen.undoRedo.requestUndo(1)
      })
      expect(requestUndo).toHaveBeenCalledWith(1)
    })

    it("does nothing when another session opened before the screen caught up", () => {
      const { store, row, requestUndo, handleOpenBranches, handleBranchFromHere } = setup()
      load(store, session([makeTurn({ id: "a1" }), makeTurn({ id: "a2" })], "a"))
      const onScreen = row()
      act(() => {
        store.dispatch({ type: "LOAD_SESSION", session: session([makeTurn({ id: "b1" }), makeTurn({ id: "b2" })], "b"), source: source("b.jsonl"), isMobile: false })
        onScreen.undoRedo.requestUndo(1)
        onScreen.actions.handleOpenBranches?.(1)
        onScreen.actions.handleBranchFromHere?.(1)
      })
      expect(requestUndo).not.toHaveBeenCalled()
      expect(handleOpenBranches).not.toHaveBeenCalled()
      expect(handleBranchFromHere).not.toHaveBeenCalled()
    })
  })
})
