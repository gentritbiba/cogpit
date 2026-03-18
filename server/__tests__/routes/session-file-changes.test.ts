// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Stats } from "node:fs"

vi.mock("../../helpers", () => ({
  findJsonlPath: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
  sendJson: (res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void }, status: number, data: unknown) => {
    res.statusCode = status
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(data))
  },
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
    expect(c.toolCallIds).toContain("tc1")
    expect(c.type).toBe("edit")
    expect(c.filePath).toBe("/src/a.ts")
    expect(c.turnIndex).toBe(0)
    expect(c.isError).toBe(false)
    expect(c.hasEdit).toBe(true)
    expect(c.hasWrite).toBe(false)
    expect(c.content).toBeUndefined()
  })

  it("parses Edit tool call with content when includeContent=true", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("fix it")]),
      assistantLine([toolUse("tc1", "Edit", { file_path: "/src/a.ts", old_string: "old", new_string: "new" })]),
      userLine([toolResult("tc1")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, true)
    expect(changes[0].content).toEqual({ originalStr: "old", currentStr: "new" })
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
    expect(changes[0].hasWrite).toBe(true)
    expect(changes[0].content).toEqual({ originalStr: "", currentStr: "export const x = 1" })
  })

  it("marks file as error when any tool_result has is_error=true", async () => {
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
    expect(changes.find((c) => c.filePath === "/a.ts")?.turnIndex).toBe(0)
    expect(changes.find((c) => c.filePath === "/b.ts")?.turnIndex).toBe(1)
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

  it("deduplicates multiple edits to the same file", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("fix stuff")]),
      assistantLine([
        toolUse("tc1", "Edit", { file_path: "/src/a.ts", old_string: "foo", new_string: "bar" }),
        toolUse("tc2", "Edit", { file_path: "/src/a.ts", old_string: "baz", new_string: "qux" }),
      ]),
      userLine([toolResult("tc1"), toolResult("tc2")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes).toHaveLength(1)
    expect(changes[0].filePath).toBe("/src/a.ts")
    expect(changes[0].toolCallIds).toEqual(["tc1", "tc2"])
    expect(changes[0].hasEdit).toBe(true)
    expect(changes[0].additions).toBeGreaterThanOrEqual(0)
    expect(changes[0].deletions).toBeGreaterThanOrEqual(0)
  })

  it("computes net diff for multiple edits with content", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("fix stuff")]),
      assistantLine([
        toolUse("tc1", "Edit", { file_path: "/src/a.ts", old_string: "line1\nline2", new_string: "line1\nchanged" }),
        toolUse("tc2", "Edit", { file_path: "/src/a.ts", old_string: "line3", new_string: "also_changed" }),
      ]),
      userLine([toolResult("tc1"), toolResult("tc2")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, true)
    expect(changes).toHaveLength(1)
    expect(changes[0].content).toBeDefined()
    expect(changes[0].content!.originalStr).toContain("line2")
    expect(changes[0].content!.currentStr).toContain("changed")
  })

  it("sets hasEdit and hasWrite when file has both operations", async () => {
    const jsonl = makeJsonl(
      userLine([humanText("create then edit")]),
      assistantLine([
        toolUse("tc1", "Write", { file_path: "/src/new.ts", content: "initial content" }),
        toolUse("tc2", "Edit", { file_path: "/src/new.ts", old_string: "initial", new_string: "updated" }),
      ]),
      userLine([toolResult("tc1"), toolResult("tc2")]),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes).toHaveLength(1)
    expect(changes[0].hasEdit).toBe(true)
    expect(changes[0].hasWrite).toBe(true)
    expect(changes[0].type).toBe("edit") // mixed defaults to edit
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

  // ── Codex format support ──────────────────────────────────────────────────

  it("parses Codex apply_patch into file changes", async () => {
    const patchInput = [
      "*** Begin Patch",
      "*** Update File: /home/user/project/src/app.ts",
      "@@",
      "-const x = 1",
      "+const x = 2",
      "@@",
    ].join("\n")
    const jsonl = makeJsonl(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2024-01-01T00:00:00.000Z",
        payload: { id: "codex-session", cwd: "/home/user/project" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2024-01-01T00:00:01.000Z",
        payload: { turn_id: "turn-1", model: "gpt-4o", cwd: "/home/user/project" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: { type: "user_message", message: "Fix it" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-patch-1",
          name: "apply_patch",
          input: patchInput,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch-1",
          output: JSON.stringify({ output: "Success.", metadata: { exit_code: 0 } }),
        },
      }),
    )
    const { changes, cwd } = await parseSessionFileChanges(jsonl, true)
    expect(cwd).toBe("/home/user/project")
    expect(changes).toHaveLength(1)
    expect(changes[0].filePath).toBe("/home/user/project/src/app.ts")
    expect(changes[0].hasEdit).toBe(true)
    expect(changes[0].content?.originalStr).toContain("const x = 1")
    expect(changes[0].content?.currentStr).toContain("const x = 2")
  })

  it("parses Codex multi-file apply_patch", async () => {
    const patchInput = [
      "*** Begin Patch",
      "*** Update File: /a.ts",
      "@@",
      "-old a",
      "+new a",
      "@@",
      "*** Add File: /b.ts",
      "@@",
      "+export const b = 1",
      "@@",
    ].join("\n")
    const jsonl = makeJsonl(
      JSON.stringify({ type: "session_meta", timestamp: "2024-01-01T00:00:00.000Z", payload: { id: "s1", cwd: "/proj" } }),
      JSON.stringify({ type: "turn_context", timestamp: "2024-01-01T00:00:01.000Z", payload: { turn_id: "t1", model: "gpt-4o" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2024-01-01T00:00:02.000Z", payload: { type: "user_message", message: "fix" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: { type: "custom_tool_call", call_id: "cp1", name: "apply_patch", input: patchInput },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: { type: "custom_tool_call_output", call_id: "cp1", output: JSON.stringify({ output: "ok", metadata: { exit_code: 0 } }) },
      }),
    )
    const { changes } = await parseSessionFileChanges(jsonl, false)
    expect(changes).toHaveLength(2)
    const aChange = changes.find((c) => c.filePath === "/a.ts")
    const bChange = changes.find((c) => c.filePath === "/b.ts")
    expect(aChange?.hasEdit).toBe(true)
    expect(bChange?.hasWrite).toBe(true)
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
    expect(data.changes[0].additions).toBeDefined()
    expect(data.changes[0].deletions).toBeDefined()
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
    expect(data.changes[0].content).toEqual({ originalStr: "a", currentStr: "b" })
  })

  it("returns file change at /sessionId/tool/:toolCallId", async () => {
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
    expect(data.toolCallIds).toContain("tc1")
    expect(data.content).toEqual({ originalStr: "a", currentStr: "b" })
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
