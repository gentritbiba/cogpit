import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { createRef, useState } from "react"
import { emptyTurn } from "@/__tests__/fixtures"
import type { ToolCall, Turn } from "../../../shared/session/types"
import type { ScrollToTurnOptions, TimelineHandle } from "@/lib/timelineScroll/types"
import { DisclosureProvider, useTimelineStore, type TimelineStateStore } from "@/components/timeline/disclosure"
import { QUOTE_SEARCH_PAGES } from "@/hooks/useQuoteNavigation"

let sessionTurns: Turn[] = []
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({ session: { turns: sessionTurns } }),
}))

import { FindInSession, type FindInSessionHandle } from "../FindInSession"

const call = (id: string, result: string): ToolCall =>
  ({ id, name: "Bash", input: { command: "ls" }, result, isError: false, timestamp: "2026-01-01T00:00:00Z" })

/** t0 is far above the view; t1 hides its match in a tool result behind the work fold; t2 is on screen. */
function makeTurns(): Turn[] {
  return [
    emptyTurn({ id: "t0", contentBlocks: [{ kind: "text", text: ["an old needle"] }] }),
    emptyTurn({
      id: "t1",
      contentBlocks: [
        { kind: "tool_calls", toolCalls: [call("c1", "found the needle in output")] },
        { kind: "text", text: ["done"] },
      ],
    }),
    emptyTurn({ id: "t2", contentBlocks: [{ kind: "text", text: ["needle once", "needle twice"] }] }),
  ]
}

interface Navigation {
  key: string
  opts: ScrollToTurnOptions
}

function makeHandle(viewportKey: string | null = null) {
  const navigations: Navigation[] = []
  const handle: TimelineHandle = {
    scrollToTurn: vi.fn(async (key: string, opts: ScrollToTurnOptions = {}) => {
      navigations.push({ key, opts })
      return true
    }),
    scrollToBottom: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getViewport: () => ({ firstVisibleKey: viewportKey, atBottom: false }),
  }
  return { handle, navigations }
}

/** A scroller holding only the rows the virtualized timeline has mounted. */
function mountScroller(rowsHtml: string): HTMLDivElement {
  const frame = document.createElement("div")
  const scroller = document.createElement("div")
  scroller.innerHTML = rowsHtml
  frame.appendChild(scroller)
  document.body.appendChild(frame)
  return scroller
}

let store: TimelineStateStore | null = null
function CaptureStore() {
  store = useTimelineStore()
  return null
}

let replaceTurns: (turns: Turn[]) => void = () => {}

function Harness({ scroller, handle, findRef, older, onLoadMore }: {
  scroller: HTMLDivElement
  handle: TimelineHandle
  findRef: React.RefObject<FindInSessionHandle | null>
  /** Pages of older history, newest first, that loading brings in like the paging hook does. */
  older?: Turn[][]
  onLoadMore?: () => void
}) {
  const [scrollRef] = useState(() => ({ current: scroller }))
  const [timelineRef] = useState(() => ({ current: handle }))
  const [turns, setTurns] = useState(sessionTurns)
  const [pages, setPages] = useState(older ?? [])
  const [loading, setLoading] = useState(false)
  sessionTurns = turns
  replaceTurns = setTurns
  const loadMore = () => {
    onLoadMore?.()
    setLoading(true)
    setTimeout(() => {
      setTurns((current) => [...(pages[0] ?? []), ...current])
      setPages(pages.slice(1))
      setLoading(false)
    }, 10)
  }
  return (
    <DisclosureProvider>
      <CaptureStore />
      <FindInSession
        ref={findRef}
        scrollContainerRef={scrollRef}
        timelineRef={timelineRef}
        hasMore={pages.length > 0}
        isLoadingOlder={loading}
        onLoadMore={older ? loadMore : undefined}
      />
    </DisclosureProvider>
  )
}

async function search(query: string) {
  fireEvent.change(screen.getByLabelText("Find in conversation"), { target: { value: query } })
  await act(async () => { vi.advanceTimersByTime(200) })
}

async function frame() {
  await act(async () => { vi.advanceTimersByTime(20) })
}

function press(key: string, shiftKey = false) {
  fireEvent.keyDown(screen.getByLabelText("Find in conversation"), { key, shiftKey })
}

/** The engine retries `target` across layout passes; the first pass precedes the reveal's render. */
function land(navigation: Navigation, row: HTMLElement): Element | null {
  const target = navigation.opts.target!
  expect(target(row)).toBeNull()
  return target(row)
}

function rowEl(html: string): HTMLElement {
  const holder = document.createElement("div")
  holder.innerHTML = html
  return holder.firstElementChild as HTMLElement
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] })
  sessionTurns = makeTurns()
  store = null
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ""
})

describe("FindInSession", () => {
  it("counts matches in unmounted rows and collapsed content, and navigates only through scrollToTurn", async () => {
    const scroller = mountScroller(`<div data-row-key="t2"><div data-blocks="0-0"><p>needle once</p><p>needle twice</p></div></div>`)
    const { handle, navigations } = makeHandle()
    const findRef = createRef<FindInSessionHandle>()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
    act(() => findRef.current!.open())

    await search("needle")
    // Only t2 is mounted, yet all four are counted: t0's text, t1's folded result, t2's two.
    expect(screen.getByText("1/4")).toBeInTheDocument()
    expect(navigations.map((n) => n.key)).toEqual(["t0"])
    expect(navigations[0].opts.align).toBe("center")

    press("Enter")
    expect(screen.getByText("2/4")).toBeInTheDocument()
    expect(navigations.at(-1)!.key).toBe("t1")
    // The result sits behind the turn's work fold, its group and the tool's panel: all opened through the store.
    expect(store!.get("t1:work")).toBe(true)
    expect(store!.get("t1:reveal")).toBe("c1")
    expect(store!.get("t1:call:c1:panel")).toBe(true)
    const t1 = rowEl(`<div data-row-key="t1"><div data-tool-call-id="c1"><span>found the </span><b>nee</b>dle in output</div></div>`)
    expect(land(navigations.at(-1)!, t1)).toBe(t1.querySelector("b"))

    press("Enter")
    press("Enter")
    expect(screen.getByText("4/4")).toBeInTheDocument()
    // The model only picks the turn; the second occurrence is found in the row's own text.
    const t2 = scroller.querySelector<HTMLElement>("[data-row-key=t2]")!
    expect(land(navigations.at(-1)!, t2)).toBe(t2.querySelectorAll("p")[1])

    press("Enter", true)
    expect(screen.getByText("3/4")).toBeInTheDocument()
    expect(land(navigations.at(-1)!, t2)).toBe(t2.querySelectorAll("p")[0])
  })

  it("starts at the first match from the top of the view down", async () => {
    const scroller = mountScroller("")
    const { handle, navigations } = makeHandle("t2")
    const findRef = createRef<FindInSessionHandle>()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
    act(() => findRef.current!.open())
    await search("needle")
    expect(screen.getByText("3/4")).toBeInTheDocument()
    expect(navigations.map((n) => n.key)).toEqual(["t2"])
  })

  it("opens long-text cuts inside the tool only when the row shows fewer occurrences than the turn has", async () => {
    sessionTurns = [emptyTurn({ id: "t0", contentBlocks: [{ kind: "tool_calls", toolCalls: [call("c1", "x\n".repeat(30) + "needle")] }] })]
    const scroller = mountScroller("")
    const { handle, navigations } = makeHandle()
    const findRef = createRef<FindInSessionHandle>()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
    act(() => findRef.current!.open())
    // Mounted disclosures register their first value; the result preview starts closed.
    store!.init("t0:call:c1:result", false)
    store!.init("t0:call:c1:input", false)
    // Booleans that are not "open" switches: a code block's fold, a sent answer, an image fetch.
    store!.init("t0:call:c1:answers:q1:sent", false)
    store!.init("t0:call:c1:image:ref1", false)
    store!.init("t0:text-1:code:120", false)
    await search("needle")

    const preview = rowEl(`<div data-row-key="t0"><div data-tool-call-id="c1">x x x</div></div>`)
    const target = navigations[0].opts.target!
    expect(land(navigations[0], preview)).toBeNull()
    expect(store!.get("t0:call:c1:result")).toBe(true)
    // Raw input would only repeat the input; it stays closed. Nothing outside the allow-list moves.
    expect(store!.get("t0:call:c1:input")).toBe(false)
    expect(store!.get("t0:call:c1:answers:q1:sent")).toBe(false)
    expect(store!.get("t0:call:c1:image:ref1")).toBe(false)
    expect(store!.get("t0:text-1:code:120")).toBe(false)
    const expanded = rowEl(`<div data-row-key="t0"><div data-tool-call-id="c1">x <i>needle</i></div></div>`)
    expect(target(expanded)).toBe(expanded.querySelector("i"))
  })

  it("counts a result's hits from the card's end, past the header and inputs that repeat the indexed text", async () => {
    sessionTurns = [emptyTurn({ id: "t0", contentBlocks: [{ kind: "tool_calls", toolCalls: [{ ...call("c1", "grep found needle"), input: { command: "grep needle" } }] }] })]
    const scroller = mountScroller("")
    const { handle, navigations } = makeHandle()
    const findRef = createRef<FindInSessionHandle>()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
    act(() => findRef.current!.open())
    await search("needle")
    expect(screen.getByText("1/2")).toBeInTheDocument()
    // The card shows the command in its header and its panel, then the result.
    const row = rowEl(`<div data-row-key="t0"><div data-tool-call-id="c1"><b>grep needle</b><pre>grep needle</pre><i>grep found needle</i></div></div>`)
    expect(land(navigations[0], row)).toBe(row.querySelector("b"))
    press("Enter")
    expect(screen.getByText("2/2")).toBeInTheDocument()
    expect(land(navigations[1], row)).toBe(row.querySelector("i"))
  })

  it("goes to the last match on Previous when the selected turn is gone", async () => {
    const scroller = mountScroller("")
    const { handle, navigations } = makeHandle()
    const findRef = createRef<FindInSessionHandle>()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
    act(() => findRef.current!.open())
    await search("needle")
    expect(navigations.at(-1)!.key).toBe("t0")
    // The selected turn leaves the session (a rewind): nothing is selected now.
    act(() => replaceTurns(makeTurns().slice(1)))
    expect(screen.getByText("0/3")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }))
    expect(navigations.at(-1)!.key).toBe("t2")
    expect(screen.getByText("3/3")).toBeInTheDocument()
  })

  it("never mutates the timeline's DOM", async () => {
    const scroller = mountScroller(`<div data-row-key="t2"><div data-blocks="0-0"><p>needle once</p><p>needle twice</p></div></div>`)
    const records: MutationRecord[] = []
    const observer = new MutationObserver((batch) => records.push(...batch))
    observer.observe(scroller, { subtree: true, childList: true, characterData: true, attributes: true })
    const { handle } = makeHandle("t2")
    const findRef = createRef<FindInSessionHandle>()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
    act(() => findRef.current!.open())
    await search("needle")
    press("Enter")
    await frame()
    await search("twice")
    await frame()
    act(() => findRef.current!.close())
    await frame()
    await Promise.resolve()
    records.push(...observer.takeRecords())
    observer.disconnect()
    expect(records).toEqual([])
    expect(scroller.innerHTML).toBe(`<div data-row-key="t2"><div data-blocks="0-0"><p>needle once</p><p>needle twice</p></div></div>`)
  })

  it("falls back to a ring over the active row where the Highlight API is missing", async () => {
    expect("highlights" in CSS).toBe(false)
    const scroller = mountScroller(`<div data-row-key="t2"><div data-blocks="0-0"><p>needle once</p></div></div>`)
    const row = scroller.firstElementChild!
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 800 }))
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 20, y: 100, width: 500, height: 200 }))
    const { handle } = makeHandle("t2")
    const findRef = createRef<FindInSessionHandle>()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
    act(() => findRef.current!.open())
    await search("needle")
    await frame()
    const ring = screen.getByTestId("find-ring")
    expect(ring.style.top).toBe("100px")
    expect(ring.style.height).toBe("200px")

    act(() => findRef.current!.close())
    await frame()
    expect(screen.queryByTestId("find-ring")).toBeNull()
  })

  it("paints matches and the active one with CSS highlights, and clears them on close", async () => {
    const registry = new Map<string, { ranges: Range[]; priority: number }>()
    class FakeHighlight {
      ranges: Range[]
      priority = 0
      constructor(...ranges: Range[]) { this.ranges = ranges }
      add(range: Range) { this.ranges.push(range) }
    }
    vi.stubGlobal("Highlight", FakeHighlight)
    Object.defineProperty(CSS, "highlights", { value: registry, configurable: true })
    try {
      const scroller = mountScroller(`<div data-row-key="t2"><div data-blocks="0-0"><p>needle once</p><p>needle twice</p></div></div>`)
      const { handle } = makeHandle("t2")
      const findRef = createRef<FindInSessionHandle>()
      const view = render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
      act(() => findRef.current!.open())
      await search("needle")
      press("Enter")
      await frame()
      expect(registry.get("find-match")!.ranges.map((r) => r.startContainer.textContent!.slice(r.startOffset, r.endOffset))).toEqual(["needle", "needle"])
      const active = registry.get("find-active")!
      expect(active.ranges).toHaveLength(1)
      expect(active.ranges[0].startContainer.parentElement).toBe(scroller.querySelectorAll("p")[1])
      expect(screen.queryByTestId("find-ring")).toBeNull()
      // Highlights style ranges; the rows' DOM is untouched.
      expect(scroller.innerHTML).toBe(`<div data-row-key="t2"><div data-blocks="0-0"><p>needle once</p><p>needle twice</p></div></div>`)

      act(() => findRef.current!.close())
      await frame()
      expect(registry.size).toBe(0)
      view.unmount()
    } finally {
      delete (CSS as { highlights?: unknown }).highlights
      vi.unstubAllGlobals()
    }
  })

  it("pages older history in, with a cap, until a match turns up there", async () => {
    sessionTurns = [emptyTurn({ id: "t9", contentBlocks: [{ kind: "text", text: ["recent"] }] })]
    const older = [
      [emptyTurn({ id: "t8", contentBlocks: [{ kind: "text", text: ["nothing"] }] })],
      [emptyTurn({ id: "t7", contentBlocks: [{ kind: "text", text: ["an ancient word"] }] })],
      [emptyTurn({ id: "t6", contentBlocks: [{ kind: "text", text: ["ancient too"] }] })],
    ]
    const scroller = mountScroller("")
    const { handle, navigations } = makeHandle()
    const findRef = createRef<FindInSessionHandle>()
    const onLoadMore = vi.fn()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} older={older} onLoadMore={onLoadMore} />)
    act(() => findRef.current!.open())
    await search("ancient")
    expect(screen.getByText("0/0")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /search older history/i }))
    expect(screen.getByRole("status")).toHaveTextContent(`Searching older history… 1/${QUOTE_SEARCH_PAGES} pages`)
    await frame()
    await frame()
    // Two pages in, the match turned up; the third page is never fetched.
    expect(onLoadMore).toHaveBeenCalledTimes(2)
    expect(screen.getByText("1/1")).toBeInTheDocument()
    expect(navigations.at(-1)!.key).toBe("t7")
  })

  it("stops paging after the cap when nothing matches", async () => {
    sessionTurns = [emptyTurn({ id: "t99" })]
    const older = Array.from({ length: QUOTE_SEARCH_PAGES + 5 }, (_, i) => [emptyTurn({ id: `old${i}` })])
    const scroller = mountScroller("")
    const { handle } = makeHandle()
    const findRef = createRef<FindInSessionHandle>()
    const onLoadMore = vi.fn()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} older={older} onLoadMore={onLoadMore} />)
    act(() => findRef.current!.open())
    await search("absent")
    fireEvent.click(screen.getByRole("button", { name: /search older history/i }))
    for (let i = 0; i < QUOTE_SEARCH_PAGES + 3; i++) await frame()
    expect(onLoadMore).toHaveBeenCalledTimes(QUOTE_SEARCH_PAGES)
    expect(screen.getByText(`No match in ${QUOTE_SEARCH_PAGES} more pages`)).toBeInTheDocument()
  })

  it("closes on Escape from any of its controls, not only the input", async () => {
    const scroller = mountScroller("")
    const { handle } = makeHandle()
    const findRef = createRef<FindInSessionHandle>()
    render(<Harness scroller={scroller} handle={handle} findRef={findRef} />)
    act(() => findRef.current!.open())
    await search("needle")
    fireEvent.keyDown(screen.getByRole("button", { name: "Next match" }), { key: "Escape" })
    expect(screen.queryByLabelText("Find in conversation")).toBeNull()
  })
})
