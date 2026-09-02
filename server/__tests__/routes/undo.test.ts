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
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
    join: posix.join,
    resolve: posix.resolve,
    homedir: () => "/home/testuser",
  }
})

vi.mock("../../sessionPaths", () => ({
  resolveSessionFilePath: vi.fn((_dirName: string, fileName: string) =>
    Promise.resolve(`/tmp/test-projects/proj/${fileName}`)
  ),
}))

const mockStoreForPath = vi.hoisted(() => vi.fn())

vi.mock("../../agents", () => ({ storeForPath: mockStoreForPath }))

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

import { readFile, writeFile, unlink } from "../../helpers"
import { lstat, realpath } from "node:fs/promises"

const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)
const mockedUnlink = vi.mocked(unlink)
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
import {
  commitFileOperations,
  prepareFileOperations,
  UndoOperationError,
} from "../../routes/undo/fileOperations"

describe("undo routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    // Every fixture path lives under the Claude projects root unless a test
    // says otherwise.
    mockStoreForPath.mockReturnValue({ kind: "claude" })
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

})

/**
 * The file-operation gate every undo mutation passes through.
 *
 * These were routed through `/api/undo/apply` until that endpoint was removed
 * as dead — nothing but a test ever called it, and real undo has gone through
 * `/api/undo/transaction` for a while. The safety rules are the valuable part,
 * so they are asserted against the module that enforces them.
 */
describe("undo file operations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedLstat.mockResolvedValue({ isSymbolicLink: () => false } as never)
    mockedRealpath.mockImplementation(((path: string) => Promise.resolve(path)) as never)
  })

  async function rejectsWith(status: number, operations: unknown): Promise<void> {
    await expect(prepareFileOperations(operations)).rejects.toMatchObject({ status })
  }

  it("rejects non-absolute paths", async () => {
    await rejectsWith(403, [
      { type: "create-write", filePath: "relative/path.txt", content: "test" },
    ])
  })

  it("rejects traversal segments even when the resolved target stays under home", async () => {
    await rejectsWith(403, [{
      type: "create-write",
      filePath: "/home/testuser/project/../other/file.ts",
      content: "test",
    }])
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("rejects empty operations array", async () => {
    await rejectsWith(400, [])
  })

  it("rejects non-array operations", async () => {
    await rejectsWith(400, "not-array")
  })

  it.each([
    ["a forbidden system directory", "/etc/passwd"],
    ["a /usr/ system path", "/usr/bin/test"],
  ])("rejects %s", async (_label, filePath) => {
    await rejectsWith(403, [{ type: "create-write", filePath, content: "test" }])
  })

  it("rejects an in-home target that is itself a symbolic link", async () => {
    mockedLstat.mockResolvedValueOnce({ isSymbolicLink: () => true } as never)

    await rejectsWith(403, [{
      type: "create-write",
      filePath: "/home/testuser/project/escape.ts",
      content: "blocked",
    }])
    expect(mockedReadFile).not.toHaveBeenCalled()
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("rejects an in-home path whose canonical target escapes home", async () => {
    mockedRealpath
      .mockResolvedValueOnce("/home/testuser" as never)
      .mockResolvedValueOnce("/tmp/outside.ts" as never)

    await rejectsWith(403, [{
      type: "reverse-edit",
      filePath: "/home/testuser/project-link/outside.ts",
      oldString: "before",
      newString: "after",
    }])
    expect(mockedReadFile).not.toHaveBeenCalled()
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("rejects a new file beneath an in-home symlinked directory that escapes home", async () => {
    mockedLstat.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
    mockedRealpath
      .mockResolvedValueOnce("/home/testuser" as never)
      .mockResolvedValueOnce("/tmp/outside" as never)

    await rejectsWith(403, [{
      type: "create-write",
      filePath: "/home/testuser/project-link/new.ts",
      content: "blocked",
    }])
    expect(mockedReadFile).not.toHaveBeenCalled()
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("applies a single reverse-edit operation", async () => {
    mockedReadFile.mockResolvedValueOnce("say hello to everyone" as unknown as Buffer)

    const batch = await prepareFileOperations([{
      type: "reverse-edit",
      filePath: "/home/testuser/project/file.ts",
      oldString: "hello",
      newString: "world",
    }])
    await commitFileOperations(batch)

    expect(batch.operationCount).toBe(1)
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/home/testuser/project/file.ts",
      "say world to everyone",
      "utf-8",
    )
  })

  it("applies replaceAll edits", async () => {
    mockedReadFile.mockResolvedValueOnce("foo and foo and foo" as unknown as Buffer)

    const batch = await prepareFileOperations([{
      type: "reverse-edit",
      filePath: "/home/testuser/project/file.ts",
      oldString: "foo",
      newString: "bar",
      replaceAll: true,
    }])
    await commitFileOperations(batch)

    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/home/testuser/project/file.ts",
      "bar and bar and bar",
      "utf-8",
    )
  })

  it("refuses an edit whose expected string is not unique", async () => {
    mockedReadFile.mockResolvedValueOnce("foo and foo" as unknown as Buffer)

    await expect(prepareFileOperations([{
      type: "reverse-edit",
      filePath: "/home/testuser/project/file.ts",
      oldString: "foo",
      newString: "bar",
    }])).rejects.toBeInstanceOf(UndoOperationError)
  })
})
