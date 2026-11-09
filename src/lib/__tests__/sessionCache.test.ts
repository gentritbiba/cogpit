import { describe, it, expect, beforeEach } from "vitest"
import { MAX_CACHED_TRANSCRIPT_BYTES, sessionCache } from "@/lib/sessionCache"
import {
  __resetDeviceRevisionsForTest,
  __resetIdentityForTest,
  recordDeviceConnectionRevision,
  setActiveIdentity,
} from "@/lib/device"
import { type SessionView } from "../../../shared/session/sessionDigest"
import type { Turn } from "../../../shared/session/types"

function setPath(pathname: string) {
  Object.defineProperty(window, "location", {
    value: { pathname },
    writable: true,
    configurable: true,
  })
}

const parsed = { turns: [] } as unknown as SessionView

function seed(dirName: string, fileName: string) {
  sessionCache.set(parsed, { dirName, fileName, watchOffset: 3, loadId: 1 }, 0, false)
}

describe("sessionCache device scoping", () => {
  beforeEach(() => {
    sessionCache.clear()
    __resetDeviceRevisionsForTest()
    __resetIdentityForTest()
    setPath("/")
  })

  it("keys entries by the active device so different devices never collide", () => {
    // Local device stores an entry for a dirName.
    setPath("/")
    seed("-Users-foo", "sess.jsonl")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()

    // The same (dirName, fileName) on a remote device is a cache MISS.
    setPath("/d/dev_x/")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()
  })

  it("keeps each device's entry warm across a switch-back", () => {
    setPath("/")
    seed("-Users-foo", "sess.jsonl")

    setPath("/d/dev_x/")
    seed("-Users-foo", "sess.jsonl") // remote entry under the scoped key
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()

    // Switch back to local — the original local entry is still cached.
    setPath("/")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()
  })

  it("evicts under the device-scoped key", () => {
    setPath("/d/dev_x/")
    seed("-Users-foo", "sess.jsonl")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()

    sessionCache.evict("-Users-foo", "sess.jsonl")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()

    // The local scope was never populated, so it stays empty too.
    setPath("/")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()
  })

  it("keeps cached transcripts isolated between signed-in users", () => {
    setActiveIdentity("u_1")
    seed("-Users-foo", "sess.jsonl")

    setActiveIdentity("u_2")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()

    setActiveIdentity("u_1")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()
  })

  it("isolates the same device id across sensitive connection revisions", () => {
    setPath("/d/dev_x/")
    recordDeviceConnectionRevision("dev_x", 4)
    seed("-Users-foo", "sess.jsonl")

    recordDeviceConnectionRevision("dev_x", 5)
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()

    // A duplicate/name-only registry notification keeps the same scope.
    recordDeviceConnectionRevision("dev_x", 5)
    seed("-Users-foo", "sess.jsonl")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()
  })
})

describe("sessionCache.evictSession", () => {
  const SESSION = "00000000-0000-4000-8000-000000000001"
  const OTHER = "00000000-0000-4000-8000-000000000002"

  beforeEach(() => {
    sessionCache.clear()
    __resetIdentityForTest()
    setPath("/")
  })

  it("drops the session's transcript and the ones filed under it, for the active device only", () => {
    seed("-work", `${SESSION}.jsonl`)
    seed("-work", `${SESSION}/subagents/agent-a1.jsonl`)
    seed("-work", `${OTHER}.jsonl`)
    setPath("/d/dev_x/")
    seed("-work", `${SESSION}.jsonl`)
    setPath("/")

    sessionCache.evictSession(SESSION)

    expect(sessionCache.get("-work", `${SESSION}.jsonl`)).toBeUndefined()
    expect(sessionCache.get("-work", `${SESSION}/subagents/agent-a1.jsonl`)).toBeUndefined()
    expect(sessionCache.get("-work", `${OTHER}.jsonl`)).toBeDefined()
    setPath("/d/dev_x/")
    expect(sessionCache.get("-work", `${SESSION}.jsonl`)).toBeDefined()
  })
})

describe("sessionCache bounds", () => {
  beforeEach(() => {
    sessionCache.clear()
    __resetDeviceRevisionsForTest()
    __resetIdentityForTest()
    setPath("/")
  })

  const views = new Map<SessionView, string>()
  function cache(fileName: string, bytes: number, at: number) {
    const view = { turns: [] } as unknown as SessionView
    views.set(view, fileName)
    sessionCache.set(view, { dirName: "-d", fileName, watchOffset: bytes, loadId: 1 }, 0, false)
    sessionCache.update("-d", fileName, 1, { lastAccessed: at })
  }

  it("keeps at most five entries, releasing the least recently used", () => {
    const released: string[] = []
    const stop = sessionCache.onRelease((view) => released.push(views.get(view) ?? "?"))
    for (let index = 0; index < 6; index++) cache(`s${index}.jsonl`, 10, index)
    stop()
    expect(released).toEqual(["s0.jsonl"])
    expect(sessionCache.get("-d", "s0.jsonl")).toBeUndefined()
    expect(sessionCache.get("-d", "s5.jsonl")).toBeDefined()
  })

  it("leaves an entry alone when a write names an earlier load of it (review #5)", () => {
    const reloaded = { turns: [] } as unknown as SessionView
    sessionCache.set({ turns: [] } as unknown as SessionView, { dirName: "-d", fileName: "a.jsonl", watchOffset: 50, loadId: 1 }, 40, true)
    sessionCache.set(reloaded, { dirName: "-d", fileName: "a.jsonl", watchOffset: 90, loadId: 2 }, 70, true)

    // A page requested before the reload lands after it.
    sessionCache.update("-d", "a.jsonl", 1, { nextByteOffset: 10, hasMore: false, olderTurns: [{ id: "old" } as unknown as Turn] })
    sessionCache.update("-d", "a.jsonl", 1, { parsed: { turns: [] } as unknown as SessionView, source: { watchOffset: 60 } })
    expect(sessionCache.get("-d", "a.jsonl")).toMatchObject({ parsed: reloaded, nextByteOffset: 70, hasMore: true, olderTurns: [], source: { watchOffset: 90, loadId: 2 } })

    sessionCache.update("-d", "a.jsonl", 2, { nextByteOffset: 30 })
    expect(sessionCache.get("-d", "a.jsonl")?.nextByteOffset).toBe(30)
  })

  it("drops other entries once the transcript they cover passes the byte bound, never the one just written", () => {
    const third = MAX_CACHED_TRANSCRIPT_BYTES / 3
    cache("a.jsonl", third, 1)
    cache("b.jsonl", third, 2)
    cache("c.jsonl", third, 3)

    // History paged in above b's tail moves its cursor back past the bound.
    sessionCache.update("-d", "b.jsonl", 1, { nextByteOffset: -third, olderTurns: [] })
    expect(sessionCache.get("-d", "a.jsonl")).toBeUndefined()
    expect(sessionCache.get("-d", "c.jsonl")).toBeDefined()

    // A single session larger than the bound stays while it is the one in use.
    sessionCache.update("-d", "c.jsonl", 1, { nextByteOffset: -2 * MAX_CACHED_TRANSCRIPT_BYTES })
    expect(sessionCache.get("-d", "c.jsonl")).toBeDefined()
    expect(sessionCache.get("-d", "b.jsonl")).toBeUndefined()
  })
})
