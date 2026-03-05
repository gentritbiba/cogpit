// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import { registerSearchIndexRoutes } from "../../routes/search-index-stats"
import type { UseFn, Middleware } from "../../helpers"

vi.mock("../../routes/session-search", () => ({
  getSearchIndex: vi.fn(),
}))

import { getSearchIndex } from "../../routes/session-search"
const mockedGetSearchIndex = vi.mocked(getSearchIndex)

// ── Test helpers ─────────────────────────────────────────────────────────────

function createMockReqRes(method: string, url: string) {
  let statusCode = 200
  const headers: Record<string, string> = {}
  let body = ""

  const req = {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }

  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v }),
    end: vi.fn((data?: string) => { body = data || "" }),
    _getData: () => body,
    _getStatus: () => statusCode,
    _getHeaders: () => headers,
  }

  const next = vi.fn()
  return { req, res, next }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerSearchIndexRoutes", () => {
  let statsHandler: Middleware
  let rebuildHandler: Middleware

  beforeEach(() => {
    vi.resetAllMocks()
    const handlers = new Map<string, Middleware>()
    const use: UseFn = (path, h) => { handlers.set(path, h) }
    registerSearchIndexRoutes(use)
    statsHandler = handlers.get("/api/search-index/stats")!
    rebuildHandler = handlers.get("/api/search-index/rebuild")!
  })

  // ── GET /api/search-index/stats ───────────────────────────────────────────

  describe("GET /api/search-index/stats", () => {
    it("calls next for non-GET methods", async () => {
      const { req, res, next } = createMockReqRes("POST", "/")
      await statsHandler(req as never, res as never, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 503 when index is not available", async () => {
      mockedGetSearchIndex.mockReturnValue(null)
      const { req, res, next } = createMockReqRes("GET", "/")
      await statsHandler(req as never, res as never, next)
      expect(res._getStatus()).toBe(503)
      const data = JSON.parse(res._getData())
      expect(data.error).toContain("not available")
    })

    it("returns stats when index is available", async () => {
      const mockStats = {
        dbPath: "/tmp/test.db",
        dbSizeBytes: 1024,
        dbSizeMB: 0.001,
        indexedFiles: 10,
        indexedSessions: 8,
        indexedSubagents: 2,
        totalRows: 100,
        watcherRunning: true,
        lastFullBuild: "2026-03-05T10:00:00.000Z",
        lastUpdate: "2026-03-05T12:00:00.000Z",
      }
      mockedGetSearchIndex.mockReturnValue({
        getStats: () => mockStats,
      } as any)

      const { req, res, next } = createMockReqRes("GET", "/")
      await statsHandler(req as never, res as never, next)

      expect(res._getStatus()).toBe(200)
      const data = JSON.parse(res._getData())
      expect(data.indexedFiles).toBe(10)
      expect(data.indexedSessions).toBe(8)
      expect(data.indexedSubagents).toBe(2)
      expect(data.totalRows).toBe(100)
      expect(data.watcherRunning).toBe(true)
      expect(data.lastFullBuild).toBe("2026-03-05T10:00:00.000Z")
      expect(data.lastUpdate).toBe("2026-03-05T12:00:00.000Z")
      expect(data.dbPath).toBe("/tmp/test.db")
      expect(data.dbSizeBytes).toBe(1024)
      expect(data.dbSizeMB).toBe(0.001)
    })

    it("returns Content-Type application/json", async () => {
      mockedGetSearchIndex.mockReturnValue({
        getStats: () => ({
          dbPath: "/tmp/test.db",
          dbSizeBytes: 0,
          dbSizeMB: 0,
          indexedFiles: 0,
          indexedSessions: 0,
          indexedSubagents: 0,
          totalRows: 0,
          watcherRunning: false,
          lastFullBuild: null,
          lastUpdate: null,
        }),
      } as any)

      const { req, res, next } = createMockReqRes("GET", "/")
      await statsHandler(req as never, res as never, next)

      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/json")
    })
  })

  // ── POST /api/search-index/rebuild ────────────────────────────────────────

  describe("POST /api/search-index/rebuild", () => {
    it("calls next for non-POST methods", async () => {
      const { req, res, next } = createMockReqRes("GET", "/")
      await rebuildHandler(req as never, res as never, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 503 when index is not available", async () => {
      mockedGetSearchIndex.mockReturnValue(null)
      const { req, res, next } = createMockReqRes("POST", "/")
      await rebuildHandler(req as never, res as never, next)
      expect(res._getStatus()).toBe(503)
      const data = JSON.parse(res._getData())
      expect(data.error).toContain("not available")
    })

    it("returns 200 with rebuilding status and triggers rebuild", async () => {
      vi.useFakeTimers()
      const mockRebuild = vi.fn()
      mockedGetSearchIndex.mockReturnValue({
        rebuild: mockRebuild,
      } as any)

      const { req, res, next } = createMockReqRes("POST", "/")
      await rebuildHandler(req as never, res as never, next)

      expect(res._getStatus()).toBe(200)
      const data = JSON.parse(res._getData())
      expect(data.status).toBe("rebuilding")

      // rebuild runs in setTimeout(0), advance timers
      vi.runAllTimers()
      expect(mockRebuild).toHaveBeenCalledOnce()
      vi.useRealTimers()
    })

    it("returns 200 even when rebuild throws", async () => {
      vi.useFakeTimers()
      const mockRebuild = vi.fn().mockImplementation(() => {
        throw new Error("rebuild failed")
      })
      mockedGetSearchIndex.mockReturnValue({
        rebuild: mockRebuild,
      } as any)

      const { req, res, next } = createMockReqRes("POST", "/")
      await rebuildHandler(req as never, res as never, next)

      // Response should still be 200 since we respond before rebuild
      expect(res._getStatus()).toBe(200)
      const data = JSON.parse(res._getData())
      expect(data.status).toBe("rebuilding")

      // rebuild runs in setTimeout(0) and throws — should not affect response
      vi.runAllTimers()
      vi.useRealTimers()
    })
  })
})
