import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearSessionListCache,
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

  it("caches a session page with its total", () => {
    writeCachedSessionPage("project-a", {
      sessions: [{ sessionId: "session-1" }],
      total: 12,
    })

    expect(readCachedSessionPage("project-a")).toEqual({
      sessions: [{ sessionId: "session-1" }],
      total: 12,
    })
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

  it("ignores corrupt persistent data", () => {
    localStorage.setItem("cogpit:session-list-cache", "not-json")
    clearSessionListCache()
    localStorage.setItem("cogpit:session-list-cache", "not-json")

    expect(readCachedList(sessionListCacheKeys.projects)).toBeUndefined()
  })
})
