// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { UseFn, Middleware } from "../../helpers"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"

// Mock helpers module
vi.mock("../../helpers", async () => {
  const { posix } = await vi.importActual<typeof import("node:path")>("node:path")
  return {
    dirs: {
      UNDO_DIR: "/tmp/test-undo",
      PROJECTS_DIR: "/tmp/test-projects",
    },
    isWithinDir: vi.fn((parent: string, child: string) => {
      const normalizedParent = parent.replace(/\/+$/, "")
      return child === normalizedParent || child.startsWith(`${normalizedParent}/`)
    }),
    isCodexDirName: vi.fn(() => false),
    resolveSessionFilePath: vi.fn((_dirName: string, fileName: string) =>
      Promise.resolve(`/tmp/test-projects/proj/${fileName}`)
    ),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
    join: posix.join,
    resolve: posix.resolve,
    homedir: () => "/home/testuser",
  }
})

vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn(),
  lstat: vi.fn(() => Promise.resolve({ isSymbolicLink: () => false })),
  realpath: vi.fn((path: string) => Promise.resolve(path)),
}))

const atomicFiles = vi.hoisted(() => ({
  writeOwnerOnlyJson: vi.fn(),
  writeOwnerOnlyText: vi.fn(),
}))

vi.mock("../../atomicJsonFile", () => atomicFiles)

const checkpointControls = vi.hoisted(() => ({
  rewindClaudeFiles: vi.fn(),
}))

vi.mock("../../sdk-session", () => checkpointControls)

import {
  isWithinDir,
  readFile,
  writeFile,
  mkdir,
  unlink,
} from "../../helpers"
import { appendFile, lstat, realpath } from "node:fs/promises"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)
const mockedMkdir = vi.mocked(mkdir)
const mockedUnlink = vi.mocked(unlink)
const mockedAppendFile = vi.mocked(appendFile)
const mockedLstat = vi.mocked(lstat)
const mockedRealpath = vi.mocked(realpath)

// Helper to simulate Express-like routing
function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: string) => void)[] = []
  const endHandlers: (() => void)[] = []
  const req = {
    method,
    url,
    setEncoding: vi.fn(),
    destroy: vi.fn(),
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

  return { req: asIncomingMessage(req), res: asServerResponse(res), next, sendBody }
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
      const handler = getRouteHandler(handlers, "/api/undo-state/")
      const { req, res, next } = createMockReqRes("GET", "test-session-123")
      mockedReadFile.mockResolvedValueOnce('{"some":"state"}' as unknown as Buffer)

      await handler(req, res, next)

      expect(res.end).toHaveBeenCalledWith('{"some":"state"}')
      expect(mockedReadFile).toHaveBeenCalledWith(
        "/tmp/test-undo/test-session-123.json",
        "utf-8",
      )
    })

    it("returns null when file does not exist", async () => {
      const handler = getRouteHandler(handlers, "/api/undo-state/")
      const { req, res, next } = createMockReqRes("GET", "missing-session")
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res.end).toHaveBeenCalledWith("null")
    })

    it.each(["..%2Foutside", "..%5Coutside"])(
      "rejects encoded session path traversal (%s)",
      async (sessionId) => {
        const handler = getRouteHandler(handlers, "/api/undo-state/")
        const { req, res, next } = createMockReqRes("GET", sessionId)

        await handler(req, res, next)

        expect(res._getStatus()).toBe(403)
        expect(mockedReadFile).not.toHaveBeenCalled()
      },
    )

    it("calls next for non-GET/POST methods", async () => {
      const handler = getRouteHandler(handlers, "/api/undo-state/")
      const { req, res, next } = createMockReqRes("DELETE", "test-session")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  describe("POST /api/undo-state/:sessionId", () => {
    it("saves undo state", async () => {
      const handler = getRouteHandler(handlers, "/api/undo-state/")
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
      expect(atomicFiles.writeOwnerOnlyJson).toHaveBeenCalledWith(
        "/tmp/test-undo/save-session.json",
        JSON.parse(body),
      )
    })

    it("rejects encoded traversal before creating or writing undo state", async () => {
      const handler = getRouteHandler(handlers, "/api/undo-state/")
      const body = JSON.stringify({ history: [] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "..%2Foutside", body)

      await handler(req, res, next)
      sendBody()

      expect(res._getStatus()).toBe(403)
      expect(mockedMkdir).not.toHaveBeenCalled()
      expect(mockedWriteFile).not.toHaveBeenCalled()
    })
  })

  describe("POST /api/undo/transaction", () => {
    const transactionBody = () => JSON.stringify({
      operations: [{
        type: "reverse-edit",
        filePath: "/home/testuser/project/file.ts",
        oldString: "new",
        newString: "old",
      }],
      session: {
        dirName: "proj",
        fileName: "sess.jsonl",
        mutation: { type: "truncate", keepLines: 1, expectedLineCount: 1 },
      },
      state: makeTransactionState(),
    })

    function makeTransactionState() {
      return {
        sessionId: "session-1",
        currentTurnIndex: 0,
        totalTurns: 1,
        branches: [],
        activeBranchId: null,
      }
    }

    it("commits file, JSONL, and undo-state changes as one mutation", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/transaction")
      const { req, res, next, sendBody } = createMockReqRes(
        "POST",
        "/api/undo/transaction",
        transactionBody(),
      )
      const missingState = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      mockedReadFile
        .mockResolvedValueOnce("new value" as unknown as Buffer)
        .mockResolvedValueOnce("original-session\n" as unknown as Buffer)
        .mockRejectedValueOnce(missingState)

      const pending = handler(req, res, next)
      sendBody()
      await pending

      expect(res._getStatus()).toBe(200)
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/home/testuser/project/file.ts",
        "old value",
        "utf-8",
      )
      expect(atomicFiles.writeOwnerOnlyText).toHaveBeenCalledWith(
        "/tmp/test-projects/proj/sess.jsonl",
        "original-session\n",
      )
      expect(atomicFiles.writeOwnerOnlyJson).toHaveBeenCalledWith(
        "/tmp/test-undo/session-1.json",
        makeTransactionState(),
      )
    })

    it("rolls back file and session changes when undo-state persistence fails", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/transaction")
      const { req, res, next, sendBody } = createMockReqRes(
        "POST",
        "/api/undo/transaction",
        transactionBody(),
      )
      const missingState = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      mockedReadFile
        .mockResolvedValueOnce("new value" as unknown as Buffer)
        .mockResolvedValueOnce("original-session\n" as unknown as Buffer)
        .mockRejectedValueOnce(missingState)
      atomicFiles.writeOwnerOnlyJson.mockRejectedValueOnce(new Error("disk full"))

      const pending = handler(req, res, next)
      sendBody()
      await pending

      expect(res._getStatus()).toBe(409)
      expect(mockedWriteFile).toHaveBeenLastCalledWith(
        "/home/testuser/project/file.ts",
        "new value",
        "utf-8",
      )
      expect(atomicFiles.writeOwnerOnlyText).toHaveBeenCalledWith(
        "/tmp/test-projects/proj/sess.jsonl",
        "original-session\n",
      )
      expect(mockedUnlink).toHaveBeenCalledWith("/tmp/test-undo/session-1.json")
      expect(JSON.parse(res._getData()).error).toContain("disk full")
    })

    it("rejects a stale transaction before mutating any file", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/transaction")
      const body = JSON.stringify({
        ...JSON.parse(transactionBody()),
        session: {
          dirName: "proj",
          fileName: "sess.jsonl",
          mutation: { type: "truncate", keepLines: 1, expectedLineCount: 2 },
        },
      })
      const { req, res, next, sendBody } = createMockReqRes(
        "POST",
        "/api/undo/transaction",
        body,
      )
      mockedReadFile
        .mockResolvedValueOnce("new value" as unknown as Buffer)
        .mockResolvedValueOnce("original-session\n" as unknown as Buffer)

      const pending = handler(req, res, next)
      sendBody()
      await pending

      expect(res._getStatus()).toBe(409)
      expect(mockedWriteFile).not.toHaveBeenCalled()
      expect(atomicFiles.writeOwnerOnlyText).not.toHaveBeenCalled()
      expect(JSON.parse(res._getData()).error).toContain("Session changed")
    })

    it("preflights and applies a native checkpoint inside the transaction", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/transaction")
      const body = JSON.stringify({
        ...JSON.parse(transactionBody()),
        checkpoint: {
          sessionId: "session-1",
          userMessageId: "message-2",
          cwd: "/home/testuser/project",
        },
      })
      const { req, res, next, sendBody } = createMockReqRes(
        "POST",
        "/api/undo/transaction",
        body,
      )
      const missingState = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      mockedReadFile
        .mockResolvedValueOnce("new value" as unknown as Buffer)
        .mockResolvedValueOnce("original-session\n" as unknown as Buffer)
        .mockRejectedValueOnce(missingState)
      checkpointControls.rewindClaudeFiles
        .mockResolvedValueOnce({ canRewind: true })
        .mockResolvedValueOnce({ canRewind: true })

      const pending = handler(req, res, next)
      sendBody()
      await pending

      expect(res._getStatus()).toBe(200)
      expect(checkpointControls.rewindClaudeFiles).toHaveBeenNthCalledWith(
        1,
        "session-1",
        "message-2",
        "/home/testuser/project",
        true,
      )
      expect(checkpointControls.rewindClaudeFiles).toHaveBeenNthCalledWith(
        2,
        "session-1",
        "message-2",
        "/home/testuser/project",
      )
      expect(mockedWriteFile).not.toHaveBeenCalled()
    })

    it("restores JSONL and state when a preflighted checkpoint cannot be applied", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/transaction")
      const body = JSON.stringify({
        ...JSON.parse(transactionBody()),
        checkpoint: {
          sessionId: "session-1",
          userMessageId: "message-2",
          cwd: "/home/testuser/project",
        },
      })
      const { req, res, next, sendBody } = createMockReqRes(
        "POST",
        "/api/undo/transaction",
        body,
      )
      mockedReadFile
        .mockResolvedValueOnce("new value" as unknown as Buffer)
        .mockResolvedValueOnce("original-session\n" as unknown as Buffer)
        .mockResolvedValueOnce('{"old":true}' as unknown as Buffer)
      checkpointControls.rewindClaudeFiles
        .mockResolvedValueOnce({ canRewind: true })
        .mockResolvedValueOnce({ canRewind: false })

      const pending = handler(req, res, next)
      sendBody()
      await pending

      expect(res._getStatus()).toBe(409)
      expect(atomicFiles.writeOwnerOnlyText).toHaveBeenCalledWith(
        "/tmp/test-projects/proj/sess.jsonl",
        "original-session\n",
      )
      expect(atomicFiles.writeOwnerOnlyText).toHaveBeenCalledWith(
        "/tmp/test-undo/session-1.json",
        '{"old":true}',
      )
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/home/testuser/project/file.ts",
        "new value",
        "utf-8",
      )
    })
  })

  // ── /api/undo/truncate-jsonl ──────────────────────────────────────────

  describe("POST /api/undo/truncate-jsonl", () => {
    it("rejects paths outside PROJECTS_DIR", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/truncate-jsonl")
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
      const handler = getRouteHandler(handlers, "/api/undo/truncate-jsonl")
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
      const handler = getRouteHandler(handlers, "/api/undo/truncate-jsonl")
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
      const handler = getRouteHandler(handlers, "/api/undo/truncate-jsonl")
      const { req, res, next } = createMockReqRes("GET", "/api/undo/truncate-jsonl")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  // ── /api/undo/append-jsonl ────────────────────────────────────────────

  describe("POST /api/undo/append-jsonl", () => {
    it("rejects paths outside PROJECTS_DIR", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/append-jsonl")
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
      const handler = getRouteHandler(handlers, "/api/undo/append-jsonl")
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
      const handler = getRouteHandler(handlers, "/api/undo/append-jsonl")
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
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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

    it("rejects traversal segments even when the resolved target stays under home", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "create-write",
          filePath: "/home/testuser/project/../other/file.ts",
          content: "test",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
      expect(mockedWriteFile).not.toHaveBeenCalled()
    })

    it("rejects empty operations array", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
      const body = JSON.stringify({ operations: [] })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("rejects non-array operations", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
      const body = JSON.stringify({ operations: "not-array" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("rejects paths in forbidden system directories", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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

    it("rejects an in-home target that is itself a symbolic link", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "create-write",
          filePath: "/home/testuser/project/escape.ts",
          content: "blocked",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)
      mockedLstat.mockResolvedValueOnce({ isSymbolicLink: () => true } as never)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
      expect(mockedReadFile).not.toHaveBeenCalled()
      expect(mockedWriteFile).not.toHaveBeenCalled()
    })

    it("rejects an in-home path whose canonical target escapes home", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "reverse-edit",
          filePath: "/home/testuser/project-link/outside.ts",
          oldString: "before",
          newString: "after",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)
      mockedRealpath
        .mockResolvedValueOnce("/home/testuser")
        .mockResolvedValueOnce("/tmp/outside.ts")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
      expect(mockedReadFile).not.toHaveBeenCalled()
      expect(mockedWriteFile).not.toHaveBeenCalled()
    })

    it("rejects a new file beneath an in-home symlinked directory that escapes home", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
      const body = JSON.stringify({
        operations: [{
          type: "create-write",
          filePath: "/home/testuser/project-link/new.ts",
          content: "blocked",
        }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", body)
      const missingTarget = Object.assign(new Error("missing"), { code: "ENOENT" })
      mockedLstat.mockRejectedValueOnce(missingTarget)
      mockedRealpath
        .mockResolvedValueOnce("/home/testuser")
        .mockResolvedValueOnce("/tmp/outside")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(403)
      })
      expect(mockedReadFile).not.toHaveBeenCalled()
      expect(mockedWriteFile).not.toHaveBeenCalled()
    })

    it("applies a single reverse-edit operation", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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
      const handler = getRouteHandler(handlers, "/api/undo/apply")
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
      const handler = getRouteHandler(handlers, "/api/undo/apply")
      const { req, res, next } = createMockReqRes("GET", "/api/undo/apply")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })

    it("rejects invalid JSON body", async () => {
      const handler = getRouteHandler(handlers, "/api/undo/apply")
      const { req, res, next, sendBody } = createMockReqRes("POST", "/api/undo/apply", "not-json{{{")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })
  })
})
