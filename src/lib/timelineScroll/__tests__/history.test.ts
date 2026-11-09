import { describe, it, expect } from "vitest"
import { LATE_RESERVE, historyNeeded, reserveHeight, shouldLoadOlder } from "../history"

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

describe("shouldLoadOlder", () => {
  const base = { hasMore: true, loading: false, placed: true, viewport: 500, viewTop: 4000 }

  it("loads when the first loaded row is within 3 viewports of the viewport top", () => {
    expect(shouldLoadOlder({ ...base, firstRowTop: 2600 })).toBe(true)
    expect(shouldLoadOlder({ ...base, firstRowTop: 5400 })).toBe(true)
  })

  it("waits while the first row is further away", () => {
    expect(shouldLoadOlder({ ...base, firstRowTop: 2400 })).toBe(false)
  })

  it.each([
    [{ hasMore: false }],
    [{ loading: true }],
    [{ placed: false }],
    [{ viewport: 0 }],
  ])("is gated by %j", (patch) => {
    expect(shouldLoadOlder({ ...base, firstRowTop: 4000, ...patch })).toBe(false)
  })
})

describe("historyNeeded", () => {
  const base = { hasMore: true, placed: true, viewport: 500, viewTop: 4000 }

  it("holds while the first loaded row is within 3 viewports, whether or not a load is running", () => {
    expect(historyNeeded({ ...base, firstRowTop: 2600 })).toBe(true)
    expect(historyNeeded({ ...base, firstRowTop: 2400 })).toBe(false)
    expect(shouldLoadOlder({ ...base, firstRowTop: 2600, loading: true })).toBe(false)
  })
})
