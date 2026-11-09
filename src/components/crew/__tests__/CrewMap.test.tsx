import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CrewMember, SessionCrew } from "../../../../shared/contracts/crew"
import { CrewMap, MAP_WINDOW_MIN, useCrewMapControls } from "../CrewMap"
import { CARD_HEIGHT, ROW_GAP } from "../crewMapLayout"

function member(sessionId: string, parentId: string | null, startedAt: number, overrides: Partial<CrewMember> = {}): CrewMember {
  return {
    sessionId, parentId, startedAt: parentId ? startedAt : null, name: parentId ? sessionId : undefined, device: null,
    address: { dirName: `-${sessionId}`, fileName: `${sessionId}.jsonl` }, outcome: "completed", waiting: [], ...overrides,
  }
}

const permission = [{ kind: "permission", askedAt: 1, requestId: "perm-1", toolName: "Bash", summary: "gh pr merge", availableDecisions: ["allow", "deny"] }] as CrewMember["waiting"]

/** lead → research (done) → scraper (running); lead → writer (needs you); lead → coder (done) → reviewer (done) */
function crew(overrides: Record<string, Partial<CrewMember>> = {}): SessionCrew {
  return {
    sessionId: "lead",
    rootId: "lead",
    members: [
      member("lead", null, 0, { customTitle: "Launch lead" }),
      member("research", "lead", 1),
      member("writer", "lead", 2, { outcome: "needs_input", waiting: permission }),
      member("coder", "lead", 3, { model: "claude-opus-5-5" }),
      member("scraper", "research", 4, { outcome: "running", status: "tool_use", toolName: "WebFetch" }),
      member("reviewer", "coder", 5),
    ].map((value) => ({ ...value, ...overrides[value.sessionId] })),
  }
}

function Harness({ value, hereId = "lead", onOpen }: { value: SessionCrew; hereId?: string; onOpen: (member: CrewMember) => void }) {
  const controls = useCrewMapControls(value.rootId)
  const names = (target: CrewMember) => target.customTitle ?? target.name ?? target.sessionId
  return <CrewMap crew={value} hereId={hereId} controls={controls} kinds={new Map()} nameOf={names} onOpen={onOpen} />
}

function renderMap(value = crew(), hereId = "lead") {
  const onOpen = vi.fn()
  const view = render(<Harness value={value} hereId={hereId} onOpen={onOpen} />)
  return { onOpen, rerender: (next: SessionCrew, here = hereId) => view.rerender(<Harness value={next} hereId={here} onOpen={onOpen} />), unmount: view.unmount }
}

const panelMap = () => screen.getAllByRole("region", { name: "Crew map" })[0]!
const cards = (scope: HTMLElement = panelMap()) => [...scope.querySelectorAll("[data-crew-map-card]")].map((card) => card.getAttribute("data-crew-map-card"))
const card = (id: string, scope: HTMLElement = panelMap()) => scope.querySelector<HTMLElement>(`[data-crew-map-card="${id}"]`)!

beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

describe("CrewMap", () => {
  it("draws every session from the root, marks where the user is, and opens a card", () => {
    const { onOpen } = renderMap(crew(), "scraper")
    expect(cards()).toEqual(["lead", "research", "scraper", "writer", "coder", "reviewer"])
    expect(card("scraper")).toHaveAttribute("aria-current", "true")
    expect(card("scraper")).toHaveTextContent("You are here")
    expect(card("writer")).toHaveAccessibleName("writer, Waiting on a permission · Bash")
    expect(card("coder")).toHaveTextContent("Opus 5.5")

    fireEvent.click(card("reviewer"))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "reviewer" }))
  })

  it("counts the root with its members, and Active counts only what works or waits", () => {
    renderMap()
    const filter = screen.getAllByRole("radiogroup", { name: "Show on the map" })[0]!
    expect(within(filter).getByRole("radio", { name: "All, 6 sessions" })).toHaveAttribute("aria-checked", "true")
    expect(within(filter).getByRole("radio", { name: "Active, 2 sessions" })).toHaveAttribute("aria-checked", "false")
  })

  it("keeps an active session's ancestors under Active, as context with their own state", () => {
    renderMap()
    fireEvent.click(screen.getAllByRole("radio", { name: "Active, 2 sessions" })[0]!)
    expect(cards()).toEqual(["lead", "research", "scraper", "writer"])
    expect(card("research")).toHaveAccessibleName("research, Finished, shown because a session it started is active")
    expect(card("lead")).toHaveAccessibleName("Launch lead, Finished, shown because a session it started is active")
    expect(card("scraper")).toHaveAccessibleName("scraper, WebFetch")
    expect(card("writer")).toHaveAccessibleName("writer, Waiting on a permission · Bash")
  })

  it("follows statuses as they change between polls", () => {
    const { rerender } = renderMap()
    fireEvent.click(screen.getAllByRole("radio", { name: "Active, 2 sessions" })[0]!)
    rerender(crew({ scraper: { outcome: "completed" }, reviewer: { outcome: "running" } }))
    expect(cards()).toEqual(["lead", "writer", "coder", "reviewer"])
    expect(screen.getAllByRole("radio", { name: "Active, 2 sessions" })[0]).toHaveAttribute("aria-checked", "true")
  })

  it("says so when nothing is active, and goes back to every session", () => {
    renderMap(crew({ scraper: { outcome: "completed" }, writer: { outcome: "completed", waiting: [] } }))
    fireEvent.click(screen.getAllByRole("radio", { name: "Active, 0 sessions" })[0]!)
    expect(screen.getByText("Nothing is active")).toBeInTheDocument()
    expect(cards()).toEqual([])

    fireEvent.click(screen.getByRole("button", { name: "Show all sessions" }))
    expect(cards()).toHaveLength(6)
  })

  it("remembers the filter on this device", () => {
    const first = renderMap()
    fireEvent.click(screen.getAllByRole("radio", { name: "Active, 2 sessions" })[0]!)
    first.unmount()
    renderMap()
    expect(screen.getAllByRole("radio", { name: "Active, 2 sessions" })[0]).toHaveAttribute("aria-checked", "true")
  })

  it("folds a branch, flags the work it hides, and keeps the fold across polls and moves within the crew", () => {
    const { rerender } = renderMap()
    fireEvent.click(within(panelMap()).getByRole("button", { name: "Fold the sessions under research" }))
    expect(cards()).not.toContain("scraper")
    const toggle = within(panelMap()).getByRole("button", { name: "Show the 1 session under research, 1 working" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("+1")

    rerender(crew({ writer: { outcome: "completed", waiting: [] } }), "coder")
    expect(cards()).toEqual(["lead", "research", "writer", "coder", "reviewer"])

    fireEvent.click(within(panelMap()).getByRole("button", { name: "Show the 1 session under research, 1 working" }))
    expect(cards()).toContain("scraper")
  })

  it("keeps folds apart for All and Active, so a fold made in All never hides active work", () => {
    renderMap()
    fireEvent.click(within(panelMap()).getByRole("button", { name: "Fold the sessions under research" }))
    fireEvent.click(screen.getAllByRole("radio", { name: "Active, 2 sessions" })[0]!)
    expect(cards()).toEqual(["lead", "research", "scraper", "writer"])
    fireEvent.click(screen.getAllByRole("radio", { name: "All, 6 sessions" })[0]!)
    expect(cards()).not.toContain("scraper")
  })

  it("starts a different crew with nothing folded", () => {
    const { rerender } = renderMap()
    fireEvent.click(within(panelMap()).getByRole("button", { name: "Fold the sessions under research" }))
    const other = crew()
    rerender({ ...other, rootId: "other", members: other.members.map((value) => (value.sessionId === "lead" ? { ...value, sessionId: "other" } : value.parentId === "lead" ? { ...value, parentId: "other" } : value)) }, "other")
    expect(cards()).toContain("scraper")
  })

  it("expands into a larger view whose cards open the session and close it", async () => {
    const { onOpen } = renderMap()
    fireEvent.click(screen.getByRole("button", { name: "Expand the map" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog.querySelector("header")).toHaveTextContent("Launch lead")
    fireEvent.click(card("coder", within(dialog).getByRole("region", { name: "Crew map" })))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "coder" }))
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("stacks a crew too deep for a narrow panel, and keeps the expanded view across", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360)
    try {
      renderMap()
      expect(panelMap()).toHaveAttribute("data-crew-map-layout", "stacked")
      expect(cards()).toEqual(["lead", "research", "scraper", "writer", "coder", "reviewer"])

      fireEvent.click(screen.getByRole("button", { name: "Expand the map" }))
      const dialog = await screen.findByRole("dialog")
      expect(within(dialog).getByRole("region", { name: "Crew map" })).toHaveAttribute("data-crew-map-layout", "across")
    } finally {
      width.mockRestore()
    }
  })

  it("draws a panel wide enough for the crew across", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900)
    try {
      renderMap()
      expect(panelMap()).toHaveAttribute("data-crew-map-layout", "across")
    } finally {
      width.mockRestore()
    }
  })

  it("keeps the card in view put when members above it finish, even though the browser clamps the shrinking scroll", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360)
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
    try {
      const lanes = (finished: number): SessionCrew => ({
        sessionId: "lead",
        rootId: "lead",
        members: [
          member("lead", null, 0),
          ...Array.from({ length: 50 }, (_, index) => member(`lane-${index}`, "lead", index + 1, { outcome: index < finished ? "completed" : "running" })),
        ],
      })
      const { rerender } = renderMap(lanes(0))
      fireEvent.click(screen.getAllByRole("radio", { name: "Active, 50 sessions" })[0]!)
      const region = panelMap()
      // Like a browser, the scroll position never exceeds what the drawn area allows.
      let stored = 0
      const limit = () => Math.max(0, Number.parseFloat((region.firstElementChild as HTMLElement).style.height) - 400)
      Object.defineProperty(region, "scrollTop", { configurable: true, get: () => Math.min(stored, limit()), set: (value: number) => { stored = value } })
      region.scrollTop = 4000
      fireEvent.scroll(region)

      rerender(lanes(30))
      // Thirty rows above it are gone, so the same card is thirty rows higher up.
      expect(region.scrollTop).toBe(4000 - 30 * (CARD_HEIGHT + ROW_GAP))
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })

  it("draws only the cards near the view of a large crew, and more as it scrolls", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360)
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
    try {
      const lanes: SessionCrew = {
        sessionId: "lead",
        rootId: "lead",
        members: [member("lead", null, 0), ...Array.from({ length: 300 }, (_, index) => member(`lane-${index}`, "lead", index + 1))],
      }
      const { rerender } = renderMap(lanes)
      const region = panelMap()
      expect(cards().length).toBeLessThan(MAP_WINDOW_MIN)
      expect(cards()).toContain("lead")
      expect(cards()).not.toContain("lane-250")

      let stored = 0
      Object.defineProperty(region, "scrollTop", { configurable: true, get: () => stored, set: (value: number) => { stored = value } })
      region.scrollTo = vi.fn()
      rerender(lanes, "lane-250")
      const target = (region.scrollTo as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { top: number }
      expect(target.top).toBeGreaterThan(0)

      stored = target.top
      fireEvent.scroll(region)
      expect(cards()).toContain("lane-250")
      expect(cards()).not.toContain("lead")
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })

  it("draws fewer cards again after zooming back in, and fills a taller view", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360)
    let viewHeight = 1_000
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewHeight)
    const resized: Array<() => void> = []
    const Observer = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: () => void) {}
      observe() { resized.push(this.callback) }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    try {
      renderMap({
        sessionId: "lead",
        rootId: "lead",
        members: [member("lead", null, 0), ...Array.from({ length: 300 }, (_, index) => member(`lane-${index}`, "lead", index + 1))],
      })
      const opened = cards().length
      for (let step = 0; step < 8; step++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }))
      const zoomedOut = cards().length
      expect(zoomedOut).toBeGreaterThan(opened)
      fireEvent.click(screen.getByRole("button", { name: "Actual size" }))
      expect(cards().length).toBeLessThan(zoomedOut)

      const before = cards().length
      viewHeight = 10_000
      act(() => { for (const callback of resized) callback() })
      expect(cards().length).toBeGreaterThan(before)
    } finally {
      globalThis.ResizeObserver = Observer
      width.mockRestore()
      height.mockRestore()
    }
  }, 20_000)

  it("zooms with its controls", () => {
    renderMap()
    const actual = screen.getByRole("button", { name: "Actual size" })
    expect(actual).toHaveTextContent("100%")
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }))
    expect(actual).toHaveTextContent("83%")
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(actual).toHaveTextContent("120%")
    fireEvent.click(actual)
    expect(actual).toHaveTextContent("100%")
  })
})
