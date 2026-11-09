import { describe, it, expect, vi } from "vitest"
import { BlockWindow, buildWindowPlan, planWindowRange, spacerHeight, type BlockWindowHost } from "../blockWindow"

const h = (...xs: number[]) => Float64Array.from(xs)
const uniform = (n: number, height: number) => new Float64Array(n).fill(height)
const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`)

function makeHost(overrides: Partial<BlockWindowHost> = {}) {
  const heights = new Map<string, number>()
  const host: BlockWindowHost = {
    attachWindow: vi.fn(() => () => {}),
    windowCommitted: vi.fn(),
    viewOffsetInRow: () => Infinity,
    viewportHeight: () => 500,
    layoutKey: () => "40|0",
    blockHeight: (key) => heights.get(key),
    setBlockHeight: (key, height) => { heights.set(key, height) },
    ...overrides,
  }
  return { host, heights }
}

function rect(top: number, height: number): DOMRect {
  return DOMRect.fromRect({ x: 0, y: top, width: 600, height })
}

describe("spacerHeight", () => {
  it("covers the items and the gaps between them, the spacer taking one gap slot itself", () => {
    expect(spacerHeight(h(10, 20, 30), 4, 0, 3)).toBe(68)
    expect(spacerHeight(h(10, 20, 30), 4, 1, 2)).toBe(20)
    expect(spacerHeight(h(10, 20, 30), 4, 2, 2)).toBe(0)
  })
})

describe("buildWindowPlan", () => {
  it("puts a spacer before each run and after the last, with pinned items as islands", () => {
    const plan = buildWindowPlan({ start: 6, end: 8 }, [2], uniform(10, 10), 0)
    expect(plan.runs).toEqual([{ start: 2, end: 3 }, { start: 6, end: 8 }])
    expect(plan.before).toEqual([20, 30])
    expect(plan.after).toBe(20)
  })
})

describe("planWindowRange", () => {
  it("mounts the viewport plus a viewport of overscan on each side", () => {
    const range = planWindowRange({ heights: uniform(100, 100), gap: 0, known: new Map(), current: null, viewTop: 5000, viewport: 500 })
    expect(range).toEqual({ start: 45, end: 60 })
  })

  it("clamps a view past the end to the tail", () => {
    const range = planWindowRange({ heights: uniform(100, 100), gap: 0, known: new Map(), current: null, viewTop: Infinity, viewport: 500 })
    expect(range.end).toBe(100)
    expect(range.start).toBeGreaterThan(80)
  })

  it("keeps the committed range while the view stays inside its band", () => {
    const current = { start: 45, end: 60 }
    expect(planWindowRange({ heights: uniform(100, 100), gap: 0, known: new Map(), current, viewTop: 5100, viewport: 500 })).toBe(current)
  })
})

/** A window over 100 items of 64px, its head mounted and laid out from y = 0. */
function mountedWindow() {
  const setBlockHeight = vi.fn()
  const { host } = makeHost({ viewOffsetInRow: () => -Infinity })
  const blockWindow = new BlockWindow({ ...host, setBlockHeight }, "w", "row")
  blockWindow.setItems(keys(100), [])
  const container = document.createElement("div")
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 6400))
  blockWindow.attach(container)
  const els: HTMLElement[] = []
  const first = blockWindow.getPlan().runs[0]
  for (let i = first.start; i < first.end; i++) {
    const el = document.createElement("div")
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(i * 64, 64))
    blockWindow.itemRef(`k${i}`)(el)
    els.push(el)
  }
  blockWindow.update({ top: 0, height: 500 }, true)
  setBlockHeight.mockClear()
  return { blockWindow, els, setBlockHeight }
}

describe("BlockWindow", () => {
  it("starts at the tail while the host follows the bottom, and at the head when it lands on the row", () => {
    const { host } = makeHost()
    const tail = new BlockWindow(host, "w", "row")
    tail.setItems(keys(100), [])
    const tailRuns = tail.getPlan().runs
    expect(tailRuns[tailRuns.length - 1].end).toBe(100)
    expect(tailRuns[0].start).toBeGreaterThan(50)

    const head = new BlockWindow({ ...host, viewOffsetInRow: () => -Infinity }, "w", "row")
    head.setItems(keys(100), [])
    expect(head.getPlan().runs[0].start).toBe(0)
    expect(head.getPlan().after).toBeGreaterThan(0)
  })

  it("keeps following items appended after a range that reached the end", () => {
    const { host } = makeHost()
    const blockWindow = new BlockWindow(host, "w", "row")
    blockWindow.setItems(keys(100), [])
    blockWindow.setItems(keys(103), [])
    const runs = blockWindow.getPlan().runs
    expect(runs[runs.length - 1].end).toBe(103)
  })

  it("keeps pinned items mounted outside the range", () => {
    const { host } = makeHost()
    const blockWindow = new BlockWindow(host, "w", "row")
    blockWindow.setItems(keys(100), ["k3"])
    expect(blockWindow.getPlan().runs[0]).toEqual({ start: 3, end: 4 })
  })

  it("sizes spacers from heights measured earlier", () => {
    const { host, heights } = makeHost({ viewOffsetInRow: () => -Infinity })
    for (let i = 0; i < 100; i++) heights.set(`w:k${i}`, i === 99 ? 1000 : 100)
    const blockWindow = new BlockWindow(host, "w", "row")
    blockWindow.setItems(keys(100), [])
    const plan = blockWindow.getPlan()
    const mounted = plan.runs[0].end
    expect(plan.after).toBe((99 - mounted) * 100 + 1000)
  })

  it("measures mounted items, re-plans for the viewport and notifies only when the range moves", () => {
    const { host, heights } = makeHost({ viewOffsetInRow: () => -Infinity })
    const blockWindow = new BlockWindow(host, "w", "row")
    blockWindow.setItems(keys(100), [])
    const container = document.createElement("div")
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 6400))
    blockWindow.attach(container)
    const first = blockWindow.getPlan().runs[0]
    for (let i = first.start; i < first.end; i++) {
      const el = document.createElement("div")
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(i * 64, 64))
      blockWindow.itemRef(`k${i}`)(el)
    }
    const listener = vi.fn()
    blockWindow.subscribe(listener)

    blockWindow.update({ top: 0, height: 500 }, true)
    expect(listener).not.toHaveBeenCalled()
    expect(heights.get("w:k0")).toBe(64)

    blockWindow.update({ top: 3000, height: 500 }, true)
    expect(listener).toHaveBeenCalledTimes(1)
    const runs = blockWindow.getPlan().runs
    expect(runs[0].start * 64).toBeLessThanOrEqual(2500)
    expect(runs[0].end * 64).toBeGreaterThanOrEqual(4000)
  })

  it("on scroll inside the band, reads only the range's edge rects and neither measures nor re-plans", () => {
    const { blockWindow, els, setBlockHeight } = mountedWindow()
    const listener = vi.fn()
    blockWindow.subscribe(listener)
    const reads = els.map((el) => vi.mocked(el.getBoundingClientRect).mock.calls.length)
    blockWindow.update({ top: 100, height: 500 }, false)
    const after = els.map((el) => vi.mocked(el.getBoundingClientRect).mock.calls.length)
    expect(after.reduce((a, b) => a + b, 0) - reads.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2)
    expect(setBlockHeight).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()

    // Past the band, the same scroll path re-plans.
    blockWindow.update({ top: 3000, height: 500 }, false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("caches only measured items, never sizes taken while a height animation runs", () => {
    const { host, heights } = makeHost({ viewOffsetInRow: () => -Infinity })
    const blockWindow = new BlockWindow(host, "w", "row")
    blockWindow.setItems(keys(100), [])
    const container = document.createElement("div")
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 6400))
    blockWindow.attach(container)
    const animating = document.createElement("div")
    vi.spyOn(animating, "getBoundingClientRect").mockReturnValue(rect(0, 40))
    class FakeKeyframeEffect {
      getKeyframes() { return [{ height: "0px" }] }
    }
    vi.stubGlobal("KeyframeEffect", FakeKeyframeEffect)
    Object.assign(animating, { getAnimations: () => [{ playState: "running", effect: new FakeKeyframeEffect() }] })
    blockWindow.itemRef("k0")(animating)
    blockWindow.update({ top: 0, height: 500 }, true)
    expect(heights.has("w:k0")).toBe(false)
    // Spacers stand in for unmounted items; nothing is cached for them.
    expect([...heights.keys()]).toEqual([])
    vi.unstubAllGlobals()
  })

  it("keeps the item holding focus mounted when the range moves away from it", () => {
    const { blockWindow, els } = mountedWindow()
    const input = document.createElement("input")
    els[0].appendChild(input)
    document.body.appendChild(els[0])
    input.focus()
    blockWindow.update({ top: 3000, height: 500 }, true)
    expect(blockWindow.getPlan().runs[0]).toEqual({ start: 0, end: 1 })
    els[0].remove()
  })

  it("keeps what the list had mounted before it was windowed until its first measured pass", () => {
    const { host } = makeHost()
    const blockWindow = new BlockWindow(host, "w", "row", ["k3", "k4"])
    blockWindow.setItems(keys(100), [])
    expect(blockWindow.getPlan().runs[0]).toEqual({ start: 3, end: 5 })
    const container = document.createElement("div")
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 6400))
    blockWindow.attach(container)
    blockWindow.update({ top: 6000, height: 500 }, true)
    expect(blockWindow.getPlan().runs).toHaveLength(1)
    expect(blockWindow.getPlan().runs[0].end).toBe(100)
  })

  it("drops heights measured for another width or expand-all setting", () => {
    let layout = "40|0"
    const cache = new Map<string, number>()
    const { host } = makeHost({
      viewOffsetInRow: () => -Infinity,
      layoutKey: () => layout,
      blockHeight: (key) => cache.get(`${layout}|${key}`),
      setBlockHeight: (key, height) => { cache.set(`${layout}|${key}`, height) },
    })
    const blockWindow = new BlockWindow(host, "w", "row")
    blockWindow.setItems(keys(100), [])
    const container = document.createElement("div")
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 6400))
    blockWindow.attach(container)
    const el = document.createElement("div")
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(0, 500))
    blockWindow.itemRef("k0")(el)
    blockWindow.update({ top: 0, height: 500 }, true)
    blockWindow.itemRef("k0")(null)
    blockWindow.update({ top: 5000, height: 500 }, true)
    const measuredBefore = blockWindow.getPlan().before[0]

    layout = "60|0"
    blockWindow.setItems(keys(101), [])
    blockWindow.update({ top: 5200, height: 500 }, true)
    // k0's 500px belonged to the old width; at this one it is an estimate again.
    expect(blockWindow.getPlan().before[0]).toBeLessThan(measuredBefore - 300)
  })

  it("asks the host to keep its anchor after every rendered range but the first", () => {
    const { host } = makeHost()
    const blockWindow = new BlockWindow(host, "w", "row")
    blockWindow.setItems(keys(100), [])
    blockWindow.rendered(blockWindow.getPlan())
    expect(host.windowCommitted).not.toHaveBeenCalled()
    blockWindow.setItems(keys(100), ["k0"])
    blockWindow.rendered(blockWindow.getPlan())
    expect(host.windowCommitted).toHaveBeenCalledTimes(1)
  })
})
