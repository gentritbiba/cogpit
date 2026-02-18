// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { UseFn, Middleware } from "../../helpers"

// Mock helpers module
vi.mock("../../helpers", () => ({
  dirs: {
    UNDO_DIR: "/tmp/test-undo",
    PROJECTS_DIR: "/tmp/test-projects",
  },
  isWithinDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
  resolve: (p: string) => {
    // Simulate path.resolve: absolute paths stay as-is, relative paths get rejected
    if (p.startsWith("/")) return p
    return "/resolved/" + p
  },
  homedir: () => "/home/testuser",
}))

vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn(),
}))

import {
  isWithinDir,
  readFile,
  writeFile,
  mkdir,
  unlink,
} from "../../helpers"
import { appendFile } from "node:fs/promises"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)
const mockedMkdir = vi.mocked(mkdir)
const mockedUnlink = vi.mocked(unlink)
const mockedAppendFile = vi.mocked(appendFile)

// Helper to simulate Express-like routing
function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: string) => void)[] = []
  const endHandlers: (() => void)[] = []
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: string) => void)
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
    _getHeaders: () => headers,
  }

  const next = vi.fn()

  // Simulate body sending
  const sendBody = () => {
    if (body) {
      for (const h of dataHandlers) h(body)
    }
    for (const h of endHandlers) h()
  }

  return { req, res, next, sendBody }
}

// Import and register routes
import { registerUndoRoutes } from "../../routes/undo"

describe("undo routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerUndoRoutes(use)
  })

  // ── /api/undo-state ──────────────────────────────────────────────────

  describe("GET /api/undo-state/:sessionId", () => {
    it("returns stored undo state", async () => {
      const handler = handlers.get("/api/undo-state/")
      const { req, res, next } = createMockReqRes("GET", "test-session-123")
      mockedReadFile.mockResolvedValueOnce('{"some":"state"}' as unknown as Buffer)

      await handler(req, res, next)

      expect(res.end).toHaveBeenCalledWith('{"some":"state"}')
    })

    it("returns null when file does not exist", async () => {
      const handler = handlers.get("/api/undo-state/")
      const { req, res, next } = createMockReqRes("GET", "missing-session")
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res.end).toHaveBeenCalledWith("null")
    })

    it("calls next for non-GET/POST methods", async () => {
      const handler = handlers.get("/api/undo-state/")
      const { req, res, next } = createMockReqRes("DELETE", "test-session")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  describe("POST /api/undo-state/:sessionId", () => {
    it("saves undo state", async () => {
      const handler = handlers.get("/api/undo-state/")
      const body = JSON.stringify({ history: [] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "save-session", body)
      mockedMkdir.mockResolvedValueOnce(undefined)
      mockedWriteFile.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      // Wait for async handlers
      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      expect(mockedMkdir).toHaveBeenCalled()
      expect(mockedWriteFile).toHaveBeenCalled()
    })
  })

  // ── /api/undo/truncate-jsonl ──────────────────────────────────────────

  describe("POST /api/undo/truncate-jsonl", () => {
    it("rejects paths outside PROJECTS_DIR", async () => {
      const handler = handlers.get("/api/undo/truncate-jsonl")
      const body = JSON.stringify({ dirName: "../../etc", fileName: "passwd", keepLines: 0 })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/truncate-jsonl", body)
      mockedIsWithinDir.mockReturnValueOnce(false)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
    })

    it("truncates file to specified number of lines", async () => {
      const handler = handlers.get("/api/undo/truncate-jsonl")
      const body = JSON.stringify({ dirName: "proj", fileName: "sess.jsonl", keepLines: 2 })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/truncate-jsonl", body)
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReadFile.mockResolvedValueOnce("line1\nline2\nline3\nline4\n" as unknown as Buffer)
      mockedWriteFile.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
      expect(response.removedLines).toEqual(["line3", "line4"])
    })

    it("no-ops when keepLines >= total lines", async () => {
      const handler = handlers.get("/api/undo/truncate-jsonl")
      const body = JSON.stringify({ dirName: "proj", fileName: "sess.jsonl", keepLines: 10 })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/truncate-jsonl", body)
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReadFile.mockResolvedValueOnce("line1\nline2\n" as unknown as Buffer)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
      expect(response.removedLines).toEqual([])
    })

    it("calls next for non-POST methods", async () => {
      const handler = handlers.get("/api/undo/truncate-jsonl")
      const { req, res, next } = createMockReqRes("GET", "/api/undo/truncate-jsonl")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  // ── /api/undo/append-jsonl ────────────────────────────────────────────

  describe("POST /api/undo/append-jsonl", () => {
    it("rejects paths outside PROJECTS_DIR", async () => {
      const handler = handlers.get("/api/undo/append-jsonl")
      const body = JSON.stringify({ dirName: "../../etc", fileName: "passwd", lines: ["data"] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/append-jsonl", body)
      mockedIsWithinDir.mockReturnValueOnce(false)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
    })

    it("appends lines to file", async () => {
      const handler = handlers.get("/api/undo/append-jsonl")
      const body = JSON.stringify({ dirName: "proj", fileName: "sess.jsonl", lines: ["line1", "line2"] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/append-jsonl", body)
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedAppendFile.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
      expect(response.appended).toBe(2)
    })

    it("no-ops for empty lines array", async () => {
      const handler = handlers.get("/api/undo/append-jsonl")
      const body = JSON.stringify({ dirName: "proj", fileName: "sess.jsonl", lines: [] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/append-jsonl", body)
      mockedIsWithinDir.mockReturnValueOnce(true)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.appended).toBe(0)
    })
  })

  // ── /api/undo/apply ───────────────────────────────────────────────────

  describe("POST /api/undo/apply", () => {
    it("rejects non-absolute paths", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{ type: "create-write", filePath: "relative/path.txt", content: "test" }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
    })

    it("rejects empty operations array", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({ operations: [] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("rejects non-array operations", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({ operations: "not-array" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("rejects paths in forbidden system directories", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{ type: "create-write", filePath: "/etc/passwd", content: "test" }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
    })

    it("rejects /usr/ system path", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{ type: "create-write", filePath: "/usr/bin/test", content: "x" }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
    })

    it("applies a single reverse-edit operation", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "reverse-edit",
          filePath: "/home/testuser/project/file.ts",
          oldString: "hello",
          newString: "world",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      mockedReadFile.mockResolvedValueOnce("say hello to everyone" as unknown as Buffer)
      mockedWriteFile.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
      expect(response.applied).toBe(1)
    })

    it("applies replaceAll edits", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "reverse-edit",
          filePath: "/home/testuser/project/file.ts",
          oldString: "foo",
          newString: "bar",
          replaceAll: true,
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      mockedReadFile.mockResolvedValueOnce("foo and foo and foo" as unknown as Buffer)
      mockedWriteFile.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
    })

    it("returns 409 when string not found (conflict)", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "reverse-edit",
          filePath: "/home/testuser/project/file.ts",
          oldString: "missing-text",
          newString: "replacement",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      mockedReadFile.mockResolvedValueOnce("some other content" as unknown as Buffer)
      mockedWriteFile.mockResolvedValue(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(409)
      })
      const response = JSON.parse(res._getData())
      expect(response.error).toContain("Conflict")
    })

    it("returns 409 when multiple occurrences found for non-replaceAll edit", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "reverse-edit",
          filePath: "/home/testuser/project/file.ts",
          oldString: "dup",
          newString: "unique",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      mockedReadFile.mockResolvedValueOnce("dup and dup again" as unknown as Buffer)
      mockedWriteFile.mockResolvedValue(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(409)
      })
      const response = JSON.parse(res._getData())
      expect(response.error).toContain("expected exactly 1 occurrence")
    })

    it("handles create-write operation", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "create-write",
          filePath: "/home/testuser/project/new.ts",
          content: "new content",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      // File doesn't exist yet
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))
      mockedWriteFile.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
    })

    it("handles delete-write operation", async () => {
      const handler = handlers.get("/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "delete-write",
          filePath: "/home/testuser/project/old.ts",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      mockedReadFile.mockResolvedValueOnce("existing content" as unknown as Buffer)
      mockedUnlink.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
    })

    it("calls next for non-POST methods", async () => {
      const handler = handlers.get("/api/undo/apply")
      const { req, res, next } = createMockReqRes("GET", "/api/undo/apply")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })

    it("rejects invalid JSON body", async () => {
      const handler = handlers.get("/api/undo/apply")
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", "not-json{{{")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })
  })
})
