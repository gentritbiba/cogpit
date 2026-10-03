import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetIdentityForTest, setActiveIdentity } from "@/lib/device"
import { rememberSignIn } from "@/lib/serverSignIn"
import {
  activeSessionsCacheKey,
  clearSessionListCache,
  evictSessionFromLists,
  readCachedList,
  readCachedSessionPage,
  sessionListCacheKeys,
  writeCachedList,
  writeCachedSessionPage,
} from "@/lib/sessionListCache"


function setPath(pathname: string) {
  Object.defineProperty(window, "location", {
    value: { pathname },
    writable: true,
    configurable: true,
  })
}

describe("sessionListCache", () => {
  beforeEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    setPath("/")
    clearSessionListCache()
  })

  it("returns cached lists synchronously", () => {
    const sessions = [{ sessionId: "session-1", aiTitle: "Cached title" }]
    writeCachedList(sessionListCacheKeys.activeSessions, sessions)

    expect(readCachedList(sessionListCacheKeys.activeSessions)).toEqual(sessions)
  })

  it("caches a session page with its total, each filter's apart", () => {
    writeCachedSessionPage("project-a", null, {
      sessions: [{ sessionId: "session-1" }],
      total: 12,
    })
    writeCachedSessionPage("project-a", "narrow", { sessions: [], total: 0 })

    expect(readCachedSessionPage("project-a", null)).toEqual({
      sessions: [{ sessionId: "session-1" }],
      total: 12,
    })
    expect(readCachedSessionPage("project-a", "narrow")).toEqual({ sessions: [], total: 0 })
    expect(readCachedSessionPage("project-a", "other")).toBeUndefined()
  })

  it("isolates cached data by active device", () => {
    writeCachedList(sessionListCacheKeys.projects, [{ dirName: "local-project" }])

    setPath("/d/device-a/")
    expect(readCachedList(sessionListCacheKeys.projects)).toBeUndefined()
    writeCachedList(sessionListCacheKeys.projects, [{ dirName: "remote-project" }])

    setPath("/")
    expect(readCachedList(sessionListCacheKeys.projects)).toEqual([{ dirName: "local-project" }])
  })

  it("ignores entries older than seven days", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"))
    writeCachedList(sessionListCacheKeys.projects, [{ dirName: "old-project" }])

    vi.setSystemTime(new Date("2026-07-09T00:00:01Z"))
    expect(readCachedList(sessionListCacheKeys.projects)).toBeUndefined()
  })

  it("drops a session from every filter's list and every project page, and nothing else", () => {
    const keep = { sessionId: "kept" }
    const lost = { sessionId: "lost" }
    writeCachedList(activeSessionsCacheKey(null), [lost, keep])
    writeCachedList(activeSessionsCacheKey("narrow"), [lost])
    writeCachedList(sessionListCacheKeys.runningProcesses, [{ pid: 1, sessionId: "lost" }])
    writeCachedList(sessionListCacheKeys.projects, [{ dirName: "project-a" }])
    writeCachedSessionPage("project-a", null, { sessions: [keep, lost], total: 30 })

    evictSessionFromLists("lost")

    expect(readCachedList(activeSessionsCacheKey(null))).toEqual([keep])
    expect(readCachedList(activeSessionsCacheKey("narrow"))).toEqual([])
    expect(readCachedList(sessionListCacheKeys.runningProcesses)).toEqual([])
    expect(readCachedList(sessionListCacheKeys.projects)).toEqual([{ dirName: "project-a" }])
    expect(readCachedSessionPage("project-a", null)).toEqual({ sessions: [keep], total: 29 })
    clearSessionListCache()
    expect(readCachedList(activeSessionsCacheKey(null))).toBeUndefined()
  })

  describe("on a server with account sign-in", () => {
    beforeEach(() => rememberSignIn("account"))
    afterEach(() => {
      rememberSignIn(null)
      __resetIdentityForTest()
    })

    it("keeps nothing until the signed-in user is known, then keeps it for that user", () => {
      writeCachedList(sessionListCacheKeys.projects, [{ dirName: "before-sign-in" }])
      expect(readCachedList(sessionListCacheKeys.projects)).toBeUndefined()
      expect(localStorage.length).toBe(0)

      setActiveIdentity("u_alice")
      writeCachedList(sessionListCacheKeys.projects, [{ dirName: "alice" }])
      expect(readCachedList(sessionListCacheKeys.projects)).toEqual([{ dirName: "alice" }])
      __resetIdentityForTest()
      expect(readCachedList(sessionListCacheKeys.projects)).toBeUndefined()
    })
  })

  it("ignores corrupt persistent data", () => {
    localStorage.setItem("cogpit:session-list-cache", "not-json")
    clearSessionListCache()
    localStorage.setItem("cogpit:session-list-cache", "not-json")

    expect(readCachedList(sessionListCacheKeys.projects)).toBeUndefined()
  })
})
