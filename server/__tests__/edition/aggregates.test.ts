// @vitest-environment node
import type { IncomingMessage } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetEditionForTest,
  allVisible,
  filterVisible,
  installEdition,
  PERSONAL_EDITION,
  takeInOrder,
  takeVisible,
  visibleInOrder,
  type VisibilityCheck,
  type VisibleItem,
  type VisibleSession,
} from "../../edition"

const SHOWN: VisibleSession = { annotate: async (item) => item }

afterEach(() => {
  __resetEditionForTest()
})

/** A check that hides every id in `hidden` and remembers what it was asked. */
function checkHiding(hidden: ReadonlySet<string>) {
  const asked: string[] = []
  const check = Object.assign(
    vi.fn(async (sessionId: string) => {
      asked.push(sessionId)
      return hidden.has(sessionId) ? "hidden" as const : SHOWN
    }),
    { everything: hidden.size === 0, nothing: false },
  ) satisfies VisibilityCheck
  return { check, asked }
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`)

async function collect<T>(items: AsyncIterable<VisibleItem<T>>, limit = Infinity): Promise<T[]> {
  const kept: T[] = []
  for await (const { item } of items) {
    kept.push(item)
    if (kept.length >= limit) break
  }
  return kept
}

describe("visibleInOrder", () => {
  it("yields the visible items in the order given, with the lineage each names", async () => {
    const { check } = checkHiding(new Set(["s1", "s3"]))
    const items = ids(5).map((sessionId) => ({ sessionId }))

    await expect(collect(visibleInOrder(items, check, (item) => item))).resolves.toEqual([
      { sessionId: "s0" }, { sessionId: "s2" }, { sessionId: "s4" },
    ])
    expect(check).toHaveBeenCalledWith("s0", undefined)
  })

  it("stops checking once the caller stops reading", async () => {
    const { check, asked } = checkHiding(new Set(["s0"]))
    const items = ids(100).map((sessionId) => ({ sessionId }))

    await expect(collect(visibleInOrder(items, check, (item) => item), 3)).resolves.toHaveLength(3)
    expect(asked.length).toBeLessThan(items.length)
    expect(asked.slice(0, 4)).toEqual(["s0", "s1", "s2", "s3"])
  })

  it("hands each visible item the session that annotates it", async () => {
    const { check } = checkHiding(new Set())
    for await (const { item, session } of visibleInOrder([{ sessionId: "s0" }], check, (entry) => entry)) {
      await expect(session.annotate(item)).resolves.toBe(item)
    }
  })
})

describe("takeVisible", () => {
  it("takes the first visible items it keeps, reading no further", async () => {
    const { check, asked } = checkHiding(new Set(["s1"]))
    const items = ids(100).map((sessionId) => ({ sessionId }))

    const taken = await takeVisible(visibleInOrder(items, check, (item) => item), 2, (item) => item.sessionId !== "s2")

    expect(taken.map(({ item }) => item.sessionId)).toEqual(["s0", "s3"])
    expect(asked.length).toBeLessThan(items.length)
  })

  it("takes nothing for a limit that is not a positive number", async () => {
    const { check, asked } = checkHiding(new Set())
    for (const limit of [0, -1, Number.NaN]) {
      await expect(takeVisible(visibleInOrder([{ sessionId: "s0" }], check, (item) => item), limit)).resolves.toEqual([])
    }
    expect(asked).toEqual([])
  })
})

describe("takeInOrder", () => {
  it("takes the first items the test passes, in order, checking no further batch", async () => {
    const asked: number[] = []
    const passes = async (item: number) => {
      asked.push(item)
      return item % 3 === 0
    }

    await expect(takeInOrder(Array.from({ length: 100 }, (_, index) => index), passes, 2)).resolves.toEqual([0, 3])
    expect(asked.length).toBeLessThan(100)
    expect(asked.slice(0, 4)).toEqual([0, 1, 2, 3])
  })

  it("takes every passing item for an unbounded limit", async () => {
    await expect(takeInOrder(ids(40), async (id) => id !== "s2", Infinity)).resolves.toEqual(ids(40).filter((id) => id !== "s2"))
  })

  it("takes nothing, and checks nothing, for a limit that is not a positive number", async () => {
    const passes = vi.fn(async () => true)
    for (const limit of [0, -1, Number.NaN]) {
      await expect(takeInOrder(ids(3), passes, limit)).resolves.toEqual([])
    }
    expect(passes).not.toHaveBeenCalled()
  })
})

describe("allVisible", () => {
  it("keeps every visible item in order, each with its session", async () => {
    const { check, asked } = checkHiding(new Set(["s2"]))
    const items = ids(40).map((sessionId) => ({ sessionId }))

    const visible = await allVisible(items, check, (item) => item)

    expect(visible.map(({ item }) => item.sessionId)).toEqual(ids(40).filter((id) => id !== "s2"))
    expect(visible.every(({ session }) => session === SHOWN)).toBe(true)
    expect(asked).toEqual(ids(40))
  })
})

describe("filterVisible", () => {
  it("keeps the visible items in order, each as its session annotates it", async () => {
    const owned: VisibleSession = { annotate: async (item) => ({ ...item, access: { level: "own", owner: null, mine: true, sharedWithMe: false } }) }
    const lost: VisibleSession = { annotate: async () => null }
    const sessions: Record<string, VisibleSession | "hidden"> = { s0: owned, s1: "hidden", s2: lost, s3: owned }
    const check = Object.assign(async (sessionId: string) => sessions[sessionId], { everything: false, nothing: false })
    const visibilityFor = vi.fn(() => check)
    installEdition({ ...PERSONAL_EDITION, edition: "team", access: { ...PERSONAL_EDITION.access, visibilityFor } })
    const req = { headers: {} } as IncomingMessage

    const visible = await filterVisible(req, ids(4).map((sessionId) => ({ sessionId })), (item) => item, "mine")

    expect(visible).toEqual([
      { sessionId: "s0", access: expect.objectContaining({ level: "own" }) },
      { sessionId: "s3", access: expect.objectContaining({ level: "own" }) },
    ])
    expect(visibilityFor).toHaveBeenCalledWith(req, "mine")
  })
})
