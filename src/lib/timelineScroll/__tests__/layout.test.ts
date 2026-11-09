import { describe, it, expect } from "vitest"
import {
  layoutTops,
  rowsOverlapping,
  planRange,
  mergeSegments,
  sumHeights,
  sameKeys,
  toExtent,
  toKeyRange,
} from "../layout"

const h = (...xs: number[]) => Float64Array.from(xs)

describe("layoutTops", () => {
  it("walks forward and backward from one known row", () => {
    const tops = layoutTops(h(10, 20, 30, 40), new Map([[2, 100]]))
    expect(Array.from(tops)).toEqual([70, 80, 100, 130])
  })

  it("trusts every known top, so islands keep their measured places", () => {
    const tops = layoutTops(h(10, 10, 10, 10, 10), new Map([[0, 0], [3, 500]]))
    expect(Array.from(tops)).toEqual([0, 10, 20, 500, 510])
  })

  it("lays out from zero when nothing is known", () => {
    expect(Array.from(layoutTops(h(5, 5), new Map()))).toEqual([0, 5])
  })
})

describe("rowsOverlapping", () => {
  const tops = Float64Array.from([0, 100, 200, 300, 400])
  const heights = h(100, 100, 100, 100, 100)
  it("returns rows that intersect the band", () => {
    expect(rowsOverlapping(tops, heights, 150, 320)).toEqual({ start: 1, end: 4 })
  })
  it("clamps above and below the rows", () => {
    expect(rowsOverlapping(tops, heights, -500, -10)).toEqual({ start: 0, end: 1 })
    expect(rowsOverlapping(tops, heights, 900, 1000)).toEqual({ start: 4, end: 5 })
  })
  it("is empty without rows", () => {
    expect(rowsOverlapping(new Float64Array(), new Float64Array(), 0, 10)).toEqual({ start: 0, end: 0 })
  })
})

describe("planRange", () => {
  const n = 100
  const heights = new Float64Array(n).fill(100)
  const tops = layoutTops(heights, new Map([[0, 0]]))
  const base = { tops, heights, viewport: 500, follow: false }

  it("renders the viewport plus one viewport of overscan on each side", () => {
    const range = planRange({ ...base, current: null, viewTop: 2000 })
    expect(range).toEqual({ start: 15, end: 30 })
  })

  it("keeps the committed range while it still covers the inner band", () => {
    const current = { start: 15, end: 30 }
    expect(planRange({ ...base, current, viewTop: 2100 })).toBe(current)
  })

  it("re-plans once scrolling leaves the inner band", () => {
    const current = { start: 15, end: 30 }
    expect(planRange({ ...base, current, viewTop: 2600 })).toEqual({ start: 21, end: 36 })
  })

  it("re-plans when the range has grown far past the outer band", () => {
    const current = { start: 0, end: 30 }
    expect(planRange({ ...base, current, viewTop: 2000 })).toEqual({ start: 15, end: 30 })
  })

  it("always reaches the last row while following", () => {
    const range = planRange({ ...base, follow: true, current: null, viewTop: 9500 })
    expect(range.end).toBe(n)
  })
})

describe("mergeSegments", () => {
  it("adds pinned rows outside the range as islands", () => {
    expect(mergeSegments({ start: 10, end: 15 }, [2, 40, 12])).toEqual([
      { start: 2, end: 3 }, { start: 10, end: 15 }, { start: 40, end: 41 },
    ])
  })
  it("joins adjacent pins into the range", () => {
    expect(mergeSegments({ start: 10, end: 15 }, [15, 9])).toEqual([{ start: 9, end: 16 }])
  })
  it("ignores pins outside the rows", () => {
    expect(mergeSegments({ start: 0, end: 2 }, [-1])).toEqual([{ start: 0, end: 2 }])
  })
})

describe("sumHeights", () => {
  it("sums a half-open slice", () => {
    expect(sumHeights(h(1, 2, 3, 4), 1, 3)).toBe(5)
    expect(sumHeights(h(1, 2), 2, 2)).toBe(0)
  })
})

describe("key ranges", () => {
  it("follow their items when others are inserted around them, and lapse when an end is gone", () => {
    const range = toKeyRange(["a", "b", "c", "d"], { start: 1, end: 3 })
    expect(range).toEqual({ first: "b", last: "c" })
    expect(toExtent(new Map([["x", 0], ["a", 1], ["b", 2], ["c", 3]]), range)).toEqual({ start: 2, end: 4 })
    expect(toExtent(new Map([["a", 0], ["c", 1]]), range)).toBeNull()
    expect(toKeyRange(["a"], { start: 0, end: 0 })).toBeNull()
  })

  it("compares key lists by content", () => {
    expect(sameKeys(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameKeys(["a", "b"], ["a"])).toBe(false)
    expect(sameKeys(["a", "b"], ["b", "a"])).toBe(false)
  })
})
