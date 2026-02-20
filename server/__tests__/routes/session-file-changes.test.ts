// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Stats } from "node:fs"

vi.mock("../../helpers", () => ({
  findJsonlPath: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

import { findJsonlPath, readFile, stat } from "../../helpers"
import { parseSessionFileChanges, registerSessionFileChangesRoutes } from "../../routes/session-file-changes"
import type { UseFn, Middleware } from "../../helpers"

const mockedFindJsonlPath = vi.mocked(findJsonlPath)
const mockedReadFile = vi.mocked(readFile)
const mockedStat = vi.mocked(stat)

// ── JSONL helpers ─────────────────────────────────────────────────────────────

function userLine(content: unknown[], meta = false) {
  return JSON.stringify({
    type: "user",
    isMeta: meta,
    message: { content },
  })
}

function assistantLine(content: unknown[]) {
  return JSON.stringify({
    type: "assistant",
    message: { content },
    cwd: "/projects/myapp",
  })
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input }
}

function toolResult(toolUseId: string, isError = false) {
  return { type: "tool_result", tool_use_id: toolUseId, content: "done", is_error: isError }
}

function humanText(text: string) {
  return { type: "text", text }
}

function makeJsonl(...lines: string[]) {
  return lines.join("\n")
}

// ── parseSessionFileChanges ───────────────────────────────────────────────────

describe("parseSessionFileChanges", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns empty changes for empty JSONL", async () => {
    const { changes, cwd } = await parseSessionFileChanges("", false)
    expect(changes).toEqual([])
    expect(cwd).toBe("")
  })

  it("extracts cwd from first line", async () => {
    const jsonl = JSON.stringify({ type: "system", cwd: "/home/user/project" })
    const { cwd } = await parseSessionFileChanges(jsonl, false)
    expect(cwd).toBe("/home/user/project")
  })

  it("returns cwd from assistant message", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("hello")]),
      assistantLine([toolUse("tc1", "Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" })]),
    )
    const { cwd } = await parseSessionFileChanges(jsonl, false)
    expect(cwd).toBe("/projects/myapp")
  })

  it("parses Edit tool call without content", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("fix it")]),
      assistantLine([toolUse("tc1", "Edit", { file_path: "/src/a.ts", old_string: "old", new_string: "new" })]),
      userLine([toolResult("tc1")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes).toHaveLength(1)
    const c = changes[0]
    expect(c.toolCallId).toBe("tc1")
    expect(c.type).toBe("edit")
    expect(c.filePath).toBe("/src/a.ts")
    expect(c.turnIndex).toBe(0)
    expect(c.isError).toBe(false)
    expect(c.content).toBeUndefined()
  })

  it("parses Edit tool call with content when includeContent=true", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("fix it")]),
      assistantLine([toolUse("tc1", "Edit", { file_path: "/src/a.ts", old_string: "old", new_string: "new" })]),
      userLine([toolResult("tc1")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, true)
    expect(changes[0].content).toEqual({ oldString: "old", newString: "new" })
  })

  it("parses Write tool call with content when includeContent=true", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("create file")]),
      assistantLine([toolUse("tc2", "Write", { file_path: "/src/b.ts", content: "export const x = 1" })]),
      userLine([toolResult("tc2")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, true)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe("write")
    expect(changes[0].content).toEqual({ fileContent: "export const x = 1" })
  })

  it("marks tool call as error when tool_result has is_error=true", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("edit")]),
      assistantLine([toolUse("tc3", "Edit", { file_path: "/x.ts", old_string: "a", new_string: "b" })]),
      userLine([toolResult("tc3", true)]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes[0].isError).toBe(true)
  })

  it("tracks turnIndex across multiple human messages", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("turn 0")]),
      assistantLine([toolUse("tc1", "Edit", { file_path: "/a.ts", old_string: "", new_string: "a" })]),
      userLine([toolResult("tc1")]),
      userLine([humanText("turn 1")]),
      assistantLine([toolUse("tc2", "Write", { file_path: "/b.ts", content: "b" })]),
      userLine([toolResult("tc2")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes).toHaveLength(2)
    expect(changes.find((c) => c.toolCallId === "tc1")?.turnIndex).toBe(0)
    expect(changes.find((c) => c.toolCallId === "tc2")?.turnIndex).toBe(1)
  })

  it("uses input.path as fallback for filePath", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("write")]),
      assistantLine([toolUse("tc1", "Write", { path: "/alt/path.ts", content: "hi" })]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes[0].filePath).toBe("/alt/path.ts")
  })

  it("skips tool_use blocks with no file_path or path", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("edit")]),
      assistantLine([toolUse("tc1", "Edit", { old_string: "a", new_string: "b" })]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes).toHaveLength(0)
  })

  it("detects deleted files from rm Bash commands", async () => {
    mockedStat.mockRejectedValueOnce(new Error("ENOENT"))
    const jsonl = makeJsonl(
      userLine([humanText("delete it")]),
      assistantLine([toolUse("bash1", "Bash", { command: 'rm "/removed/file.ts"' })]),
      userLine([toolResult("bash1")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    const deleted = changes.find((c) => c.type === "deleted")
    expect(deleted).toBeDefined()
    expect(deleted?.filePath).toBe("/removed/file.ts")
    expect(deleted?.turnIndex).toBe(0)
  })

  it("does not include deleted file if it still exists on disk", async () => {
    mockedStat.mockResolvedValueOnce({} as Stats)
    const jsonl = makeJsonl(
      userLine([humanText("rm")]),
      assistantLine([toolUse("bash1", "Bash", { command: 'rm "/still/exists.ts"' })]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes.filter((c) => c.type === "deleted")).toHaveLength(0)
  })

  it("does not duplicate deleted file already covered by Edit/Write", async () => {
    // /file.ts is also in a Write tool call → should not appear as deleted
    mockedStat.mockRejectedValueOnce(new Error("ENOENT"))
    const jsonl = makeJsonl(
      userLine([humanText("write then rm")]),
      assistantLine([
        toolUse("tc1", "Write", { file_path: "/file.ts", content: "x" }),
        toolUse("bash1", "Bash", { command: 'rm "/file.ts"' }),
      ]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes.filter((c) => c.type === "deleted")).toHaveLength(0)
    expect(changes.filter((c) => c.type === "write")).toHaveLength(1)
  })

  it("handles git rm commands", async () => {
    mockedStat.mockRejectedValueOnce(new Error("ENOENT"))
    const jsonl = makeJsonl(
      userLine([humanText("git rm")]),
      assistantLine([toolUse("bash1", "Bash", { command: "git rm /old/file.ts" })]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes.find((c) => c.type === "deleted")?.filePath).toBe("/old/file.ts")
  })

  it("sorts changes by turnIndex", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("turn 0")]),
      assistantLine([toolUse("tc1", "Edit", { file_path: "/z.ts", old_string: "", new_string: "a" })]),
      userLine([toolResult("tc1")]),
      userLine([humanText("turn 1")]),
      assistantLine([toolUse("tc2", "Edit", { file_path: "/a.ts", old_string: "", new_string: "b" })]),
      userLine([toolResult("tc2")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes[0].turnIndex).toBeLessThanOrEqual(changes[1].turnIndex)
  })
})

// ── HTTP route tests ──────────────────────────────────────────────────────────

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
  }

  const next = vi.fn()
  return { req, res, next }
}

describe("registerSessionFileChangesRoutes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = new Map()
    const use: UseFn = (path, handler) => { handlers.set(path, handler) }
    registerSessionFileChangesRoutes(use)
  })

  it("calls next for non-GET methods", async () => {
    const handler = handlers.get("/api/session-file-changes/")!
    const { req, res, next } = createMockReqRes("POST", "/session-abc")
    await handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })

  it("returns 404 when session not found", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce(null)
    const handler = handlers.get("/api/session-file-changes/")!
    const { req, res, next } = createMockReqRes("GET", "/missing-session")
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(404)
    expect(JSON.parse(res._getData())).toMatchObject({ error: "Session not found" })
  })

  it("returns changes list for valid session", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
    mockedReadFile.mockResolvedValueOnce(
      makeJsonl(
        userLine([humanText("fix")]),
        assistantLine([toolUse("tc1", "Edit", { file_path: "/app.ts", old_string: "a", new_string: "b" })]),
        userLine([toolResult("tc1")]),
      ) as never,
    )
    const handler = handlers.get("/api/session-file-changes/")!
    const { req, res, next } = createMockReqRes("GET", "/session-abc")
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.sessionId).toBe("session-abc")
    expect(data.changes).toHaveLength(1)
    expect(data.changes[0].content).toBeUndefined()
  })

  it("includes content when ?content=true", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
    mockedReadFile.mockResolvedValueOnce(
      makeJsonl(
        userLine([humanText("fix")]),
        assistantLine([toolUse("tc1", "Edit", { file_path: "/app.ts", old_string: "a", new_string: "b" })]),
        userLine([toolResult("tc1")]),
      ) as never,
    )
    const handler = handlers.get("/api/session-file-changes/")!
    const { req, res, next } = createMockReqRes("GET", "/session-abc?content=true")
    await handler(req as never, res as never, next)
    const data = JSON.parse(res._getData())
    expect(data.changes[0].content).toEqual({ oldString: "a", newString: "b" })
  })

  it("returns single tool call at /sessionId/tool/:toolCallId", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
    mockedReadFile.mockResolvedValueOnce(
      makeJsonl(
        userLine([humanText("fix")]),
        assistantLine([toolUse("tc1", "Edit", { file_path: "/app.ts", old_string: "a", new_string: "b" })]),
        userLine([toolResult("tc1")]),
      ) as never,
    )
    const handler = handlers.get("/api/session-file-changes/")!
    const { req, res, next } = createMockReqRes("GET", "/session-abc/tool/tc1")
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.toolCallId).toBe("tc1")
    expect(data.content).toEqual({ oldString: "a", newString: "b" })
  })

  it("returns 404 for unknown tool call ID", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
    mockedReadFile.mockResolvedValueOnce(
      makeJsonl(
        userLine([humanText("fix")]),
        assistantLine([toolUse("tc1", "Edit", { file_path: "/app.ts", old_string: "a", new_string: "b" })]),
      ) as never,
    )
    const handler = handlers.get("/api/session-file-changes/")!
    const { req, res, next } = createMockReqRes("GET", "/session-abc/tool/nonexistent")
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(404)
    expect(JSON.parse(res._getData())).toMatchObject({ error: "Tool call not found" })
  })

  it("calls next for unknown path shapes", async () => {
    const handler = handlers.get("/api/session-file-changes/")!
    const { req, res, next } = createMockReqRes("GET", "/session/extra/unknown/path")
    await handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })
})
