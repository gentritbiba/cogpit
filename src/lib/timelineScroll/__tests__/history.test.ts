import { describe, it, expect } from "vitest"
import { LATE_RESERVE, historyNeeded, reserveHeight } from "../history"

describe("reserveHeight", () => {
  const base = { hasMore: true, viewport: 800, loadedHeight: 10_000, loadedBytes: 100_000 }

  it("estimates the remaining history from measured px per byte", () => {
    expect(reserveHeight({ ...base, remainingBytes: 50_000 })).toBe(5_000)
  })

  it("is capped at 12 viewports", () => {
    expect(reserveHeight({ ...base, remainingBytes: 10_000_000 })).toBe(9_600)
  })

  it("falls back to a few viewports when the density is unknown", () => {
    expect(reserveHeight({ ...base, loadedBytes: 0, remainingBytes: 50_000 })).toBe(2_400)
  })

  // Harness final pass: a late page left 12 viewports of placeholder reachable, 386 frames blank on big/desktop.
  it("shrinks to the loading status while needed history is late", () => {
    expect(reserveHeight({ ...base, remainingBytes: 10_000_000, late: true })).toBe(LATE_RESERVE)
    expect(reserveHeight({ ...base, loadedBytes: 0, remainingBytes: 50_000, late: true })).toBe(LATE_RESERVE)
    expect(reserveHeight({ ...base, remainingBytes: 100, late: true })).toBe(10)
  })

  it("is empty once history is exhausted", () => {
    expect(reserveHeight({ ...base, hasMore: false, remainingBytes: 50_000 })).toBe(0)
  })
})

describe("historyNeeded", () => {
  const base = { hasMore: true, placed: true, viewport: 500, viewTop: 4000 }

  it("holds while the first loaded row is within 3 viewports of the viewport top", () => {
    expect(historyNeeded({ ...base, firstRowTop: 2600 })).toBe(true)
    expect(historyNeeded({ ...base, firstRowTop: 5400 })).toBe(true)
    expect(historyNeeded({ ...base, firstRowTop: 2400 })).toBe(false)
  })

  it.each([
    [{ hasMore: false }],
    [{ placed: false }],
    [{ viewport: 0 }],
  ])("is gated by %j", (patch) => {
    expect(historyNeeded({ ...base, firstRowTop: 4000, ...patch })).toBe(false)
  })
})
