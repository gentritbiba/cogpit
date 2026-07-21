// @vitest-environment node

import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  getConfig: vi.fn(),
  platform: vi.fn(() => "darwin" as NodeJS.Platform),
  stat: vi.fn(),
}))

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }))
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, platform: mocks.platform }
})
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, stat: mocks.stat }
})
vi.mock("../../config", () => ({
  getConfig: mocks.getConfig,
  getDirs: (claudeDir: string) => ({ PROJECTS_DIR: `${claudeDir}/projects` }),
}))

import type { Middleware, UseFn } from "../../http"
import { registerEditorRoutes } from "../../routes/editor"

function registerHandlers(): Map<string, Middleware> {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => { handlers.set(path, handler) }
  registerEditorRoutes(use)
  return handlers
}

function request(body: string, method = "POST") {
  return Object.assign(Readable.from([body]), { method, url: "/" })
}

function response() {
  const headers = new Map<string, string>()
  return {
    statusCode: 200,
    headers,
    setHeader: vi.fn((name: string, value: string | number | readonly string[]) => {
      headers.set(name.toLowerCase(), String(value))
    }),
    end: vi.fn(),
  }
}

function parseResponseBody(res: ReturnType<typeof response>): unknown {
  const value = res.end.mock.calls.at(-1)?.[0]
  return typeof value === "string" ? JSON.parse(value) : undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getConfig.mockReturnValue({
    claudeDir: "/tmp/.claude",
    editorApp: "code",
    terminalApp: "Terminal",
  })
  mocks.platform.mockReturnValue("darwin")
  mocks.stat.mockResolvedValue({ isFile: () => true })
  mocks.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback === "function") callback(null, "")
  })
})

describe("editor routes", () => {
  it("registers the three action endpoints", () => {
    expect([...registerHandlers().keys()]).toEqual([
      "/api/reveal-in-folder",
      "/api/open-terminal",
      "/api/open-in-editor",
    ])
  })

  it("rejects invalid and oversized JSON bodies with typed client statuses", async () => {
    const handler = registerHandlers().get("/api/reveal-in-folder")
    if (!handler) throw new Error("Reveal route was not registered")

    const invalidResponse = response()
    await handler(request("not-json") as never, invalidResponse as never, vi.fn())
    expect(invalidResponse.statusCode).toBe(400)
    expect(parseResponseBody(invalidResponse)).toEqual({ error: "Invalid JSON body" })

    const nullResponse = response()
    await handler(request("null") as never, nullResponse as never, vi.fn())
    expect(nullResponse.statusCode).toBe(400)
    expect(parseResponseBody(nullResponse)).toEqual({ error: "Invalid JSON body" })

    const oversizedResponse = response()
    await handler(
      request(JSON.stringify({ path: `/${"x".repeat(64 * 1024)}` })) as never,
      oversizedResponse as never,
      vi.fn(),
    )
    expect(oversizedResponse.statusCode).toBe(413)
    expect(parseResponseBody(oversizedResponse)).toEqual({ error: "Request body too large" })
    expect(mocks.stat).not.toHaveBeenCalled()
  })

  it("returns a stable validation error when no action path is provided", async () => {
    const handler = registerHandlers().get("/api/open-terminal")
    if (!handler) throw new Error("Terminal route was not registered")
    const res = response()

    await handler(request("{}") as never, res as never, vi.fn())

    expect(res.statusCode).toBe(400)
    expect(parseResponseBody(res)).toEqual({ error: "path or dirName required" })
  })

  it("reveals an existing macOS path through Finder", async () => {
    const handler = registerHandlers().get("/api/reveal-in-folder")
    if (!handler) throw new Error("Reveal route was not registered")
    const res = response()

    await handler(
      request(JSON.stringify({ path: "/tmp/project/file.ts" })) as never,
      res as never,
      vi.fn(),
    )

    expect(mocks.stat).toHaveBeenCalledWith("/tmp/project/file.ts")
    expect(mocks.execFile).toHaveBeenCalledWith(
      "open",
      ["-R", "/tmp/project/file.ts"],
      expect.any(Function),
    )
    expect(res.statusCode).toBe(200)
    expect(parseResponseBody(res)).toEqual({ success: true })
  })

  it("preserves editor line and column navigation", async () => {
    const handler = registerHandlers().get("/api/open-in-editor")
    if (!handler) throw new Error("Editor route was not registered")
    const res = response()

    await handler(
      request(JSON.stringify({ path: "/tmp/project/file.ts", line: 42, column: 7 })) as never,
      res as never,
      vi.fn(),
    )

    expect(mocks.execFile).toHaveBeenCalledWith(
      "code",
      ["--goto", "/tmp/project/file.ts:42:7"],
      expect.any(Function),
    )
    expect(parseResponseBody(res)).toEqual({ success: true, editor: "code" })
  })

  it("forwards unsupported methods without reading the body", async () => {
    const handler = registerHandlers().get("/api/open-terminal")
    if (!handler) throw new Error("Terminal route was not registered")
    const next = vi.fn()

    await handler(request("{}", "GET") as never, response() as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(mocks.stat).not.toHaveBeenCalled()
  })
})
