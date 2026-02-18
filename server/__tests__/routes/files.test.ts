// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Stats } from "node:fs"

// Mock helpers module
vi.mock("../../helpers", () => ({
  spawn: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

import { stat, lstat } from "../../helpers"

const mockedStat = vi.mocked(stat)
const mockedLstat = vi.mocked(lstat)


import type { UseFn, Middleware } from "../../helpers"
import { registerFileRoutes } from "../../routes/files"

function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: (() => void)[] = []
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: Buffer) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      return req
    }),
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }

  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value }),
    end: vi.fn((data?: string) => { endData = data || "" }),
    _getData: () => endData,
    _getStatus: () => statusCode,
  }

  const next = vi.fn()

  const sendBody = () => {
    if (body) {
      for (const h of dataHandlers) h(Buffer.from(body))
    }
    for (const h of endHandlers) h()
  }

  return { req, res, next, sendBody }
}

describe("file routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerFileRoutes(use)
  })

  describe("POST /api/check-files-exist", () => {
    it("calls next for non-POST methods", async () => {
      const handler = handlers.get("/api/check-files-exist")
      const { req, res, next } = createMockReqRes("GET", "/api/check-files-exist")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })

    it("returns empty deleted array for empty input", async () => {
      const handler = handlers.get("/api/check-files-exist")
      const body = JSON.stringify({ files: [], dirs: [] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/check-files-exist", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.deleted).toEqual([])
    })

    it("returns empty deleted for files that exist", async () => {
      const handler = handlers.get("/api/check-files-exist")
      const body = JSON.stringify({ files: ["/existing/file.txt"] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/check-files-exist", body)
      mockedStat.mockResolvedValueOnce({ isDirectory: () => false } as unknown as Stats)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.deleted).toEqual([])
    })

    it("rejects invalid JSON body", async () => {
      const handler = handlers.get("/api/check-files-exist")
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/check-files-exist", "not-json")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("skips empty string file entries", async () => {
      const handler = handlers.get("/api/check-files-exist")
      const body = JSON.stringify({ files: ["", ""], dirs: [] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/check-files-exist", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.deleted).toEqual([])
    })

    it("handles missing files and dirs fields gracefully", async () => {
      const handler = handlers.get("/api/check-files-exist")
      const body = JSON.stringify({})
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/check-files-exist", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.deleted).toEqual([])
    })

    it("skips directories that still exist on disk", async () => {
      const handler = handlers.get("/api/check-files-exist")
      const body = JSON.stringify({ dirs: ["/home/user/existing-dir"] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/check-files-exist", body)
      mockedLstat.mockResolvedValueOnce({ isDirectory: () => true } as unknown as Stats)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.deleted).toEqual([])
    })

    it("skips empty and non-string dir entries", async () => {
      const handler = handlers.get("/api/check-files-exist")
      const body = JSON.stringify({ dirs: ["", null] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/check-files-exist", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.deleted).toEqual([])
    })
  })
})
