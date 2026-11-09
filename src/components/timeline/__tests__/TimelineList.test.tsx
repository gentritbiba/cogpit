import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render } from "@testing-library/react"
import { TimelineScrollController } from "@/lib/timelineScroll/controller"
import { turnKeysOf } from "@/lib/timelineScroll/turnKeys"
import { emptyTurn } from "@/__tests__/fixtures"
import type { Turn } from "../../../../shared/session/types"

// ── Contexts and rows ────────────────────────────────────────────────────────

const appState = { activeTurnIndex: null as number | null, activeToolCallId: null as string | null, expandAll: false }
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ state: appState }),
}))
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({ undoRedo: { enabled: false, branchesAtTurn: undefined }, isSubAgentView: false, session: null }),
}))
vi.mock("@/components/UndoRedoBar", () => ({ UndoRedoBar: () => null }))
// Each turn renders two anchored blocks whose heights the test controls, and marks itself when it is the selected turn.
vi.mock("../TurnSection", async () => {
  const { useIsActiveTurn } = await vi.importActual<typeof import("../disclosure")>("../disclosure")
  return {
    TurnSection: ({ turnKey }: { turnKey: string }) => (
      <>
        <div data-scroll-anchor="" data-block={`${turnKey}:a`} />
        <div data-scroll-anchor="" data-block={`${turnKey}:b`}><button type="button">toggle</button></div>
        {useIsActiveTurn(turnKey) && <span data-active-turn={turnKey} />}
      </>
    ),
  }
})

import { TimelineList } from "../TimelineList"
import { DisclosureProvider } from "../disclosure"

// ── A block layout model over jsdom ──────────────────────────────────────────

const VIEWPORT = 500
const BLOCK = 50
const blockHeights = new Map<string, number>()
/** Height of a block the test has not sized. */
let blockSize = BLOCK
let rawScrollTop = 0
let scroller: HTMLElement | null = null
const writes: number[] = []
let resizeCallback: ResizeObserverCallback | null = null

function heightOf(el: Element): number {
  if (!(el instanceof HTMLElement)) return 0
  if (el.dataset.block) return blockHeights.get(el.dataset.block) ?? blockSize
  if (el.classList.contains("absolute")) return 0
  if (el.style.height) return parseFloat(el.style.height)
  let total = 0
  for (const child of el.children) total += heightOf(child)
  return total
}

function offsetIn(el: Element, ancestor: Element): number {
  let offset = 0
  let node: Element = el
  while (node !== ancestor && node.parentElement) {
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) offset += heightOf(sibling)
    node = node.parentElement
  }
  return offset
}

const isScroller = (el: Element) => el === scroller
const maxScroll = () => Math.max(0, heightOf(scroller!) - VIEWPORT)
const scrollTop = () => Math.min(rawScrollTop, maxScroll())

const originals = new Map<string, PropertyDescriptor | undefined>()
function patch(name: string, descriptor: PropertyDescriptor) {
  originals.set(name, Object.getOwnPropertyDescriptor(Element.prototype, name))
  Object.defineProperty(Element.prototype, name, { configurable: true, ...descriptor })
}

beforeEach(() => {
  blockHeights.clear()
  blockSize = BLOCK
  rawScrollTop = 0
  writes.length = 0
  appState.activeTurnIndex = null
  appState.activeToolCallId = null
  appState.expandAll = false
  patch("scrollTop", {
    get(this: Element) { return isScroller(this) ? scrollTop() : 0 },
    set(this: Element, value: number) {
      if (!isScroller(this)) return
      writes.push(value)
      rawScrollTop = Math.max(0, value)
    },
  })
  patch("scrollHeight", { get(this: Element) { return isScroller(this) ? heightOf(this) : 0 } })
  patch("clientHeight", { get(this: Element) { return isScroller(this) ? VIEWPORT : heightOf(this) } })
  patch("clientWidth", { get() { return 800 } })
  patch("getBoundingClientRect", {
    value(this: Element) {
      const top = isScroller(this) ? 0 : scroller && scroller.contains(this) ? offsetIn(this, scroller) - scrollTop() : 0
      const height = isScroller(this) ? VIEWPORT : heightOf(this)
      return { top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} }
    },
  })
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(Element.prototype, name, descriptor)
    else delete (Element.prototype as unknown as Record<string, unknown>)[name]
  }
  originals.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  scroller = null
})

// ── Rendering ────────────────────────────────────────────────────────────────

function makeTurns(ids: string[]): Turn[] {
  return ids.map((id) => emptyTurn({ id, userMessage: `prompt ${id}` }))
}

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `t${from + i}`)

interface Props {
  turns: Turn[]
  hasMore?: boolean
  onLoadMore?: () => void
  sessionChangeKey?: number
  sessionKey?: string
}

function Harness({ controller, turns, hasMore = false, onLoadMore, sessionChangeKey = 1, sessionKey = "s1" }: Props & { controller: TimelineScrollController }) {
  const keys = turnKeysOf(turns)
  const rows = turns.map((turn, index) => ({ turn, index, key: keys[index] }))
  return (
    <DisclosureProvider sessionKey={sessionKey}>
    <div ref={(el) => { scroller = el; controller.setScroller(el as HTMLDivElement | null) }}>
      <div>
        <TimelineList
          rows={rows}
          turnCount={turns.length}
          controller={controller}
          sessionKey={sessionKey}
          sessionChangeKey={sessionChangeKey}
          hasMore={hasMore}
          isLoadingOlder={false}
          onLoadMore={onLoadMore}
        />
      </div>
      <div ref={controller.setBottomSlack} />
    </div>
    </DisclosureProvider>
  )
}

function mount(props: Props, controller = new TimelineScrollController()) {
  const view = render(<Harness controller={controller} {...props} />)
  reported = scrollTop()
  return {
    controller,
    rerender: (next: Props) => view.rerender(<Harness controller={controller} {...next} />),
  }
}

/** The browser reports scroll position changes with an event after the fact. */
let reported = 0
function flushScroll() {
  if (scrollTop() === reported) return
  reported = scrollTop()
  act(() => { scroller!.dispatchEvent(new Event("scroll")) })
}

function userScrollTo(value: number) {
  rawScrollTop = value
  flushScroll()
}

function resize() {
  act(() => { resizeCallback?.([], {} as ResizeObserver) })
  flushScroll()
}

/** Scrolls so the viewport top sits `into` px inside a rendered block, and returns that block's selector. */
function readFrom(blockKey: string, into = 10): string {
  const selector = block(blockKey)
  userScrollTo(scrollTop() + viewportTopOf(selector) + into)
  return selector
}

const renderedKeys = () => [...scroller!.querySelectorAll<HTMLElement>("[data-row-key]")].map((row) => row.dataset.rowKey)
const viewportTopOf = (selector: string) => scroller!.querySelector(selector)!.getBoundingClientRect().top
const block = (key: string) => `[data-block="${key}"]`

beforeEach(() => { reported = 0 })

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TimelineList with the scroll engine", () => {
  it("opens at the bottom, rendering only rows near it", () => {
    const { controller } = mount({ turns: makeTurns(ids(0, 200)) })
    expect(scrollTop()).toBe(maxScroll())
    const keys = renderedKeys()
    expect(keys).toContain("t199")
    expect(keys.length).toBeLessThan(30)
    expect(controller.getIndicators()).toEqual({ canScrollDown: false })
  })

  // Review finding 10: a placement flag in the snapshot re-rendered App on every session open.
  it("does not notify the chrome when a session opens at the bottom", () => {
    const controller = new TimelineScrollController()
    const notified = vi.fn()
    controller.subscribeIndicators(notified)
    const { rerender } = mount({ turns: makeTurns(ids(0, 200)), sessionKey: "open-a" }, controller)
    rerender({ turns: makeTurns(ids(300, 400)), sessionChangeKey: 2, sessionKey: "open-b" })
    expect(notified).not.toHaveBeenCalled()
  })

  it("opens a sub-agent view at its first row", () => {
    const controller = new TimelineScrollController()
    controller.requestTopOnNextSession()
    mount({ turns: makeTurns(ids(0, 200)) }, controller)
    expect(renderedKeys()).toContain("t0")
    expect(viewportTopOf('[data-row-key="t0"]')).toBeCloseTo(0)
  })

  it("pins streaming growth to the bottom inside the resize callback", () => {
    mount({ turns: makeTurns(ids(0, 50)) })
    blockHeights.set("t49:b", 400)
    resize()
    expect(scrollTop()).toBe(maxScroll())
  })

  // Root cause 2: a scroll-up with no wheel, touch or key event did not
  // release following, so the next growth pulled the reader back down.
  it("releases following on a scroll-up during growth", () => {
    const { controller } = mount({ turns: makeTurns(ids(0, 50)) })
    userScrollTo(scrollTop() - 300)
    const before = viewportTopOf(block("t47:a"))
    blockHeights.set("t49:b", 400)
    resize()
    expect(viewportTopOf(block("t47:a"))).toBe(before)
    expect(controller.getIndicators().canScrollDown).toBe(true)
  })

  it("releases following when the scrollbar is grabbed", () => {
    mount({ turns: makeTurns(ids(0, 50)) })
    const top = scrollTop()
    act(() => { scroller!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", clientX: 805 })) })
    blockHeights.set("t49:b", 400)
    resize()
    expect(scrollTop()).toBe(top)
  })

  // Review finding 1: every press released following, and at the bottom nothing brought it back.
  it("keeps following through a tap, a text-selection press and a press on the scroller's padding", () => {
    mount({ turns: makeTurns(ids(0, 50)) })
    act(() => {
      scroller!.querySelector(block("t49:a"))!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch" }))
      scroller!.querySelector(block("t48:b"))!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
      scroller!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch", clientX: 400 }))
      scroller!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse", clientX: 400 }))
    })
    blockHeights.set("t49:b", 400)
    resize()
    expect(scrollTop()).toBe(maxScroll())
  })

  it("resumes following at idle when a release left the reader at the bottom with nothing held", () => {
    vi.useFakeTimers()
    mount({ turns: makeTurns(ids(0, 50)) })
    act(() => { scroller!.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 })) })
    act(() => { vi.advanceTimersByTime(200) })
    blockHeights.set("t49:b", 400)
    resize()
    expect(scrollTop()).toBe(maxScroll())
  })

  // Review finding 2: with focus on the body, PageDown or End scroll the timeline without a key event on it.
  it("resumes following when a scroll it did not write reaches the bottom", () => {
    vi.useFakeTimers()
    mount({ turns: makeTurns(ids(0, 50)) })
    act(() => { scroller!.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 })) })
    userScrollTo(scrollTop() - 600)
    act(() => { vi.advanceTimersByTime(200) })
    userScrollTo(maxScroll())
    blockHeights.set("t49:b", 400)
    resize()
    expect(scrollTop()).toBe(maxScroll())
  })

  it("does not resume following when a collapse clamps the reader to the bottom", () => {
    mount({ turns: makeTurns(ids(0, 50)) })
    act(() => { scroller!.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 })) })
    userScrollTo(scrollTop() - 40)
    blockHeights.set("t49:a", 0)
    blockHeights.set("t49:b", 0)
    resize()
    blockHeights.set("t49:b", 600)
    resize()
    expect(scrollTop()).toBeLessThan(maxScroll())
  })

  it("resumes following from the jump-to-bottom button", () => {
    const { controller } = mount({ turns: makeTurns(ids(0, 200)) })
    userScrollTo(4000)
    act(() => controller.scrollToBottom())
    flushScroll()
    expect(renderedKeys()).toContain("t199")
    expect(scrollTop()).toBe(maxScroll())
    blockHeights.set("t199:b", 300)
    resize()
    expect(scrollTop()).toBe(maxScroll())
    expect(controller.getIndicators().canScrollDown).toBe(false)
  })

  // Root cause 1: virtua compensated a row that starts above the viewport
  // only while scrolling down.
  it("keeps the anchor when a visible row that starts above the viewport grows above it", () => {
    mount({ turns: makeTurns(ids(0, 200)) })
    userScrollTo(scrollTop() - 3000)
    const row = renderedKeys()[10]!
    const anchor = readFrom(`${row}:b`)
    const below = block(`${renderedKeys()[11]}:a`)
    const before = [viewportTopOf(anchor), viewportTopOf(below)]
    const writesBefore = writes.length
    blockHeights.set(`${row}:a`, 350)
    resize()
    expect(viewportTopOf(anchor)).toBeCloseTo(before[0])
    expect(viewportTopOf(below)).toBeCloseTo(before[1])
    expect(writes.length).toBe(writesBefore)
  })

  // Root cause 1: virtua's shift mode compensated every resize after a
  // prepend, including growth far below the reader.
  it("keeps the anchor through a prepend and streaming growth after it", () => {
    const turns = makeTurns(ids(100, 200))
    const { rerender } = mount({ turns, hasMore: true })
    userScrollTo(scrollTop() - 2500)
    const anchor = readFrom(`${renderedKeys()[8]}:a`)
    const before = viewportTopOf(anchor)
    rerender({ turns: [...makeTurns(ids(80, 100)), ...turns], hasMore: true })
    flushScroll()
    expect(viewportTopOf(anchor)).toBeCloseTo(before)
    blockHeights.set("t199:b", 900)
    resize()
    expect(viewportTopOf(anchor)).toBeCloseTo(before)
  })

  it("prepends older rows next to the reader without writing scrollTop", () => {
    const turns = makeTurns(ids(100, 120))
    const { rerender } = mount({ turns, hasMore: true })
    userScrollTo(0)
    const anchor = readFrom("t100:a")
    const before = viewportTopOf(anchor)
    const writesBefore = writes.length
    rerender({ turns: [...makeTurns(ids(95, 100)), ...turns], hasMore: true })
    expect(renderedKeys()).toContain("t95")
    expect(viewportTopOf(anchor)).toBeCloseTo(before)
    expect(writes.length).toBe(writesBefore)
  })

  it("keeps an activated control under the pointer in the last turn", () => {
    const { controller } = mount({ turns: makeTurns(ids(0, 30)) })
    const target = scroller!.querySelector(`${block("t29:b")} button`)!
    act(() => { target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })) })
    const before = target.getBoundingClientRect().top
    blockHeights.set("t29:a", 10)
    resize()
    expect(target.getBoundingClientRect().top).toBeCloseTo(before)
    blockHeights.set("t29:b", 400)
    resize()
    expect(target.getBoundingClientRect().top).toBeCloseTo(before)
    expect(controller.getIndicators().canScrollDown).toBe(true)
  })

  it("adds bottom slack instead of letting a shrink below the reader clamp them", () => {
    mount({ turns: makeTurns(ids(0, 30)) })
    userScrollTo(scrollTop() - 60)
    const anchor = block("t28:b")
    const before = viewportTopOf(anchor)
    blockHeights.set("t29:b", 0)
    resize()
    expect(viewportTopOf(anchor)).toBe(before)
  })

  it("lands navigation on a row that was not rendered", async () => {
    const { controller } = mount({ turns: makeTurns(ids(0, 200)) })
    expect(renderedKeys()).not.toContain("t20")
    let landed: Promise<boolean> = Promise.resolve(false)
    act(() => { landed = controller.scrollToTurn("t20") })
    await act(async () => { await landed })
    expect(await landed).toBe(true)
    expect(viewportTopOf('[data-row-key="t20"]')).toBeCloseTo(0)
    flushScroll()
    expect(viewportTopOf('[data-row-key="t20"]')).toBeCloseTo(0)
    expect(controller.getViewport()).toEqual({ firstVisibleKey: "t20", atBottom: false })
  })

  it("lands navigation on a target inside the row", async () => {
    const { controller } = mount({ turns: makeTurns(ids(0, 200)) })
    let landed: Promise<boolean> = Promise.resolve(false)
    act(() => { landed = controller.scrollToTurn("t20", { target: (row) => row.querySelector('[data-block="t20:b"]') }) })
    await act(async () => { await landed })
    expect(viewportTopOf(block("t20:b"))).toBeCloseTo(0)
  })

  it("waits for a target that appears after the next layout, landing the row meanwhile", async () => {
    const { controller } = mount({ turns: makeTurns(ids(0, 200)) })
    let ready = false
    let landed: Promise<boolean> = Promise.resolve(false)
    let settled = false
    act(() => {
      landed = controller.scrollToTurn("t20", { target: (row) => ready ? row.querySelector('[data-block="t20:b"]') : null })
      void landed.then(() => { settled = true })
    })
    await act(async () => {})
    expect(viewportTopOf('[data-row-key="t20"]')).toBeCloseTo(0)
    expect(settled).toBe(false)
    ready = true
    resize()
    await act(async () => { await landed })
    expect(await landed).toBe(true)
    expect(viewportTopOf(block("t20:b"))).toBeCloseTo(0)
  })

  it("does not land navigation on a turn that is not loaded", async () => {
    const { controller } = mount({ turns: makeTurns(ids(0, 20)) })
    await expect(controller.scrollToTurn("missing")).resolves.toBe(false)
  })

  it("jumps to the turn selected in the panels", () => {
    const { rerender } = mount({ turns: makeTurns(ids(0, 200)) })
    appState.activeTurnIndex = 40
    rerender({ turns: makeTurns(ids(0, 200)) })
    expect(viewportTopOf('[data-row-key="t40"]')).toBeCloseTo(0)
  })

  it("does not jump again when a prepend shifts the selected turn's index", () => {
    const { rerender, controller } = mount({ turns: makeTurns(ids(100, 200)) })
    appState.activeTurnIndex = 40
    rerender({ turns: makeTurns(ids(100, 200)) })
    expect(viewportTopOf('[data-row-key="t140"]')).toBeCloseTo(0)
    const jump = vi.spyOn(controller, "scrollToTurn")
    userScrollTo(scrollTop() + 3000)
    // The selection keeps its index while older turns arrive: it now names another turn.
    rerender({ turns: makeTurns(ids(80, 200)) })
    // Or it moves with its turn.
    appState.activeTurnIndex = 60
    rerender({ turns: makeTurns(ids(80, 200)) })
    expect(jump).not.toHaveBeenCalled()
    // A new selection still jumps.
    appState.activeTurnIndex = 10
    rerender({ turns: makeTurns(ids(80, 200)) })
    expect(jump).toHaveBeenCalledWith("t90", { align: "start" })
  })

  // LOAD QA F7 (crew 2275): the selected turn's ring stayed on the index after older turns were prepended.
  it("marks the turn the selection jumped to, not whatever turn later takes its index", () => {
    const { rerender } = mount({ turns: makeTurns(ids(100, 200)), sessionKey: "active-turn" })
    appState.activeTurnIndex = 40
    rerender({ turns: makeTurns(ids(100, 200)), sessionKey: "active-turn" })
    const marked = () => [...scroller!.querySelectorAll<HTMLElement>("[data-active-turn]")].map((el) => el.dataset.activeTurn)
    expect(marked()).toEqual(["t140"])
    rerender({ turns: makeTurns(ids(80, 200)), sessionKey: "active-turn" })
    expect(marked()).toEqual(["t140"])
    appState.activeTurnIndex = null
    rerender({ turns: makeTurns(ids(80, 200)), sessionKey: "active-turn" })
    expect(marked()).toEqual([])
  })

  it("jumps to a tool call by key: asks its turn to reveal it, then centres its card", () => {
    const { rerender, controller } = mount({ turns: makeTurns(ids(0, 200)) })
    const jump = vi.spyOn(controller, "scrollToTurn")
    appState.activeTurnIndex = 40
    appState.activeToolCallId = "call-7"
    rerender({ turns: makeTurns(ids(0, 200)) })
    expect(jump).toHaveBeenCalledTimes(1)
    const [key, opts] = jump.mock.calls[0]
    expect(key).toBe("t40")
    expect(opts!.align).toBe("center")
    const row = document.createElement("div")
    row.innerHTML = '<div data-tool-call-id="call-6"></div><div data-tool-call-id="call-7"></div>'
    expect(opts!.target!(row)).toBe(row.lastElementChild)
    // Another call in the same turn is a new selection.
    appState.activeToolCallId = "call-6"
    rerender({ turns: makeTurns(ids(0, 200)) })
    expect(jump).toHaveBeenCalledTimes(2)
  })

  // Review finding 3: rows measured before an expand-all toggle kept their old heights while unmounted.
  it("forgets measured heights when expand-all toggles", () => {
    const turns = makeTurns(ids(0, 200))
    const { rerender, controller } = mount({ turns, sessionKey: "expand-toggle" })
    userScrollTo(scrollTop() - 6000)
    expect(renderedKeys()).not.toContain("t199")
    blockSize = 150
    appState.expandAll = true
    rerender({ turns, sessionKey: "expand-toggle" })
    // Rows below are measured expanded or estimated, none carried at its collapsed 100 px.
    const plan = controller.getPlan()
    const below = 199 - Number(plan.segments.at(-1)!.last.slice(1))
    expect(plan.bottomPad).toBeGreaterThanOrEqual(below * 240)
  })

  it("loads older history once the first row is within three viewports", () => {
    const onLoadMore = vi.fn()
    const turns = makeTurns(ids(0, 200))
    mount({ turns, hasMore: true, onLoadMore })
    expect(onLoadMore).not.toHaveBeenCalled()
    userScrollTo(2000)
    expect(onLoadMore).toHaveBeenCalled()
  })

  it("loads older history right away when the loaded rows are short", () => {
    const onLoadMore = vi.fn()
    mount({ turns: makeTurns(ids(0, 5)), hasMore: true, onLoadMore })
    expect(onLoadMore).toHaveBeenCalled()
  })

  // Harness final pass: with a page late, the reader scrolled through 12 viewports of placeholder and sat there blank.
  it("stops the reader at the loaded top while needed history is late, without moving what is on screen", () => {
    vi.useFakeTimers()
    const onLoadMore = vi.fn()
    mount({ turns: makeTurns(ids(0, 200)), hasMore: true, onLoadMore, sessionKey: "late-history" })
    userScrollTo(1600)
    expect(onLoadMore).toHaveBeenCalled()
    const anchor = block(`${renderedKeys()[1]}:a`)
    const before = viewportTopOf(anchor)
    act(() => { vi.advanceTimersByTime(600) })
    flushScroll()
    expect(viewportTopOf(anchor)).toBeCloseTo(before)
    userScrollTo(0)
    expect(viewportTopOf('[data-row-key="t0"]')).toBeLessThanOrEqual(48)
  })

  it("normalizes the top pad at idle without moving the reader", () => {
    vi.useFakeTimers()
    mount({ turns: makeTurns(ids(0, 200)) })
    userScrollTo(scrollTop() - 3000)
    const row = renderedKeys()[3]!
    blockHeights.set(`${row}:a`, 400)
    resize()
    const anchor = block(`${renderedKeys()[8]}:a`)
    const before = viewportTopOf(anchor)
    act(() => { vi.advanceTimersByTime(200) })
    flushScroll()
    expect(viewportTopOf(anchor)).toBe(before)
  })

  it("stops its idle timer once the reader settles", () => {
    vi.useFakeTimers()
    mount({ turns: makeTurns(ids(0, 200)) })
    userScrollTo(scrollTop() - 1000)
    act(() => { vi.advanceTimersByTime(200) })
    expect(vi.getTimerCount()).toBe(0)
  })

  // Review finding 4: a ref closure stayed for every row key ever rendered, across sessions.
  it("drops the row refs of another session's rows when a session starts", () => {
    const { rerender, controller } = mount({ turns: makeTurns(ids(0, 30)), sessionKey: "refs-a" })
    const left = controller.rowRef("t29")
    rerender({ turns: makeTurns(ids(100, 120)), sessionChangeKey: 2, sessionKey: "refs-b" })
    expect(controller.rowRef("t29")).not.toBe(left)
  })

  it("marks the list as a feed with positioned articles", () => {
    mount({ turns: makeTurns(ids(0, 3)) })
    const feed = scroller!.querySelector('[role="feed"]')!
    expect(feed.getAttribute("aria-busy")).toBe("false")
    const rows = feed.querySelectorAll('[role="article"]')
    expect(rows[0].getAttribute("aria-posinset")).toBe("1")
    expect(rows[0].getAttribute("aria-setsize")).toBe("3")
  })

  // Review finding 11: feed articles could not take focus, so the feed keyboard pattern was unavailable.
  it("lets an article take focus, keeping it mounted where it is while the reader scrolls away", () => {
    mount({ turns: makeTurns(ids(0, 200)) })
    const row = scroller!.querySelector<HTMLElement>('[data-row-key="t195"]')!
    const writesBefore = writes.length
    act(() => row.focus())
    expect(document.activeElement).toBe(row)
    expect(writes.length).toBe(writesBefore)
    userScrollTo(1000)
    expect(renderedKeys()).toContain("t195")
    expect(document.activeElement).toBe(row)
  })
})
