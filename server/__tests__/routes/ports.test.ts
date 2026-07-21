// @vitest-environment node
import { EventEmitter } from "node:events"
import type { FileHandle } from "node:fs/promises"
import type { Socket } from "node:net"
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, readlink: vi.fn() }
})

vi.mock("../../helpers", () => ({
  dirs: { PROJECTS_DIR: "/projects" },
  spawn: vi.fn(),
  createConnection: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
  join: vi.fn((...parts: string[]) => parts.join("/")),
}))

import { readlink } from "node:fs/promises"
import {
  createConnection,
  join,
  lstat,
  open,
  readdir,
  stat,
} from "../../helpers"
import type { Middleware, UseFn } from "../../http"
import { registerPortRoutes } from "../../routes/ports"
import {
  asIncomingMessage,
  asServerResponse,
  getRouteHandler,
} from "../http-fixtures"

interface OutputFixture {
  content?: string
  lstatError?: boolean
  mtimeMs?: number
  statError?: boolean
  symlink?: boolean
  target?: string
}

interface MockSocket extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>
  setTimeout: ReturnType<typeof vi.fn>
}

const mockedCreateConnection = vi.mocked(createConnection) as unknown as Mock<
  (options: { port: number; host: string }) => Socket
>
const mockedJoin = vi.mocked(join)
const mockedLstat = vi.mocked(lstat)
const mockedOpen = vi.mocked(open)
const mockedReadlink = vi.mocked(readlink)
const mockedReaddir = vi.mocked(readdir)
const mockedStat = vi.mocked(stat)

const fixtures = new Map<string, OutputFixture>()
const livePorts = new Set<number>()
const sockets = new Map<number, MockSocket>()

function fixtureFor(filePath: string): OutputFixture | undefined {
  return fixtures.get(filePath)
    ?? [...fixtures.values()].find((fixture) => fixture.target === filePath)
}

function taskDirectory(cwd: string): string {
  const uid = process.getuid?.() ?? 501
  const projectHash = cwd.replace(/\//g, "-").replace(/ /g, "-").replace(/@/g, "-").replace(/\./g, "-")
  return `/private/tmp/claude-${uid}/${projectHash}/tasks`
}

function addOutput(
  cwd: string,
  fileName: string,
  fixture: OutputFixture,
): string {
  const filePath = `${taskDirectory(cwd)}/${fileName}`
  fixtures.set(filePath, fixture)
  return filePath
}

function createMockReqRes(method: string, url: string) {
  let body = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const req = asIncomingMessage({ method, url })
  const res = asServerResponse({
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value }),
    end: vi.fn((data?: string) => { body = data ?? "" }),
    getBody: () => body,
    getHeader: (name: string) => headers[name],
    getStatus: () => statusCode,
  })
  const next = vi.fn()
  return { req, res, next }
}

describe("background process port routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    fixtures.clear()
    livePorts.clear()
    sockets.clear()

    mockedLstat.mockImplementation(async (filePath) => {
      const fixture = fixtureFor(String(filePath))
      if (!fixture || fixture.lstatError) throw new Error("lstat failed")
      return { isSymbolicLink: () => fixture.symlink === true } as never
    })
    mockedReadlink.mockImplementation(async (filePath) => {
      const fixture = fixtures.get(String(filePath))
      if (!fixture?.target) throw new Error("readlink failed")
      return fixture.target
    })
    mockedStat.mockImplementation(async (filePath) => {
      const fixture = fixtureFor(String(filePath))
      if (!fixture || fixture.statError) throw new Error("stat failed")
      return {
        mtimeMs: fixture.mtimeMs ?? 0,
        size: Buffer.byteLength(fixture.content ?? ""),
      } as never
    })
    mockedOpen.mockImplementation(async (filePath) => {
      const fixture = fixtureFor(String(filePath))
      if (!fixture) throw new Error("open failed")
      const content = Buffer.from(fixture.content ?? "")
      return {
        read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
          const bytesRead = content.copy(buffer, offset, 0, length)
          return { bytesRead, buffer }
        }),
        close: vi.fn(async () => undefined),
      } as unknown as FileHandle
    })
    mockedCreateConnection.mockImplementation((options) => {
      const port = options.port
      const socket = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      }) as MockSocket
      sockets.set(port, socket)
      queueMicrotask(() => socket.emit(livePorts.has(port) ? "connect" : "error"))
      return socket as unknown as Socket
    })

    handlers = new Map()
    const use: UseFn = (path, handler) => { handlers.set(path, handler) }
    registerPortRoutes(use)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("registers both public endpoint paths", () => {
    expect(handlers.has("/api/background-agents")).toBe(true)
    expect(handlers.has("/api/background-tasks")).toBe(true)
  })

  it.each([
    "/api/background-agents",
    "/api/background-tasks",
  ])("delegates unsupported methods and nested paths for %s", async (route) => {
    const handler = getRouteHandler(handlers, route)
    const post = createMockReqRes("POST", "/?cwd=/tmp/project")
    await handler(post.req, post.res, post.next)
    expect(post.next).toHaveBeenCalledTimes(1)

    const nested = createMockReqRes("GET", "/nested?cwd=/tmp/project")
    await handler(nested.req, nested.res, nested.next)
    expect(nested.next).toHaveBeenCalledTimes(1)
  })

  it.each([
    "/api/background-agents",
    "/api/background-tasks",
  ])("returns the existing 400 payload when cwd is absent for %s", async (route) => {
    const handler = getRouteHandler(handlers, route)
    const { req, res, next } = createMockReqRes("GET", "/")

    await handler(req, res, next)

    expect(res.getStatus()).toBe(400)
    expect(JSON.parse(res.getBody())).toEqual({ error: "cwd query param required" })
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    "/api/background-agents",
    "/api/background-tasks",
  ])("returns the existing 500 payload for unexpected setup failures in %s", async (route) => {
    mockedJoin.mockImplementationOnce(() => { throw new Error("unexpected") })
    const handler = getRouteHandler(handlers, route)
    const { req, res, next } = createMockReqRes("GET", "/?cwd=/tmp/project")

    await handler(req, res, next)

    expect(res.getStatus()).toBe(500)
    expect(JSON.parse(res.getBody())).toEqual({ error: "Error: unexpected" })
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    "/api/background-agents",
    "/api/background-tasks",
  ])("treats an unreadable tasks directory as an empty collection for %s", async (route) => {
    mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))
    const handler = getRouteHandler(handlers, route)
    const { req, res, next } = createMockReqRes("GET", "/?cwd=/tmp/project")

    await handler(req, res, next)

    expect(res.getStatus()).toBe(200)
    expect(res.getHeader("Content-Type")).toBe("application/json")
    expect(JSON.parse(res.getBody())).toEqual([])
    expect(next).not.toHaveBeenCalled()
  })

  it("returns only valid background-agent symlinks, newest first, with both preview shapes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(120_000)
    const cwd = "/tmp/My.Project@app"
    const oldTarget = "/projects/proj-old/parent-old/subagents/agent-old.jsonl"
    const newTarget = "/projects/proj-new/parent-new/subagents/agent-new.jsonl"
    const badTarget = "/elsewhere/proj/parent/subagents/agent-bad.jsonl"
    addOutput(cwd, "regular.output", { content: "port 4000", symlink: false })
    addOutput(cwd, "agent-old.output", {
      symlink: true,
      target: oldTarget,
      content: [
        "not-json",
        JSON.stringify({ type: "user", isMeta: true, message: { content: "ignore" } }),
        JSON.stringify({ type: "user", message: { content: "old task description" } }),
      ].join("\n"),
      mtimeMs: 1_000,
    })
    addOutput(cwd, "agent-new.output", {
      symlink: true,
      target: newTarget,
      content: JSON.stringify({
        type: "user",
        message: { content: [{ type: "image" }, { type: "text", text: "new array task description" }] },
      }),
      mtimeMs: 100_000,
    })
    addOutput(cwd, "bad-target.output", { symlink: true, target: badTarget })
    addOutput(cwd, "broken.output", { lstatError: true })
    mockedReaddir.mockResolvedValueOnce([
      "regular.output",
      "agent-old.output",
      "ignored.txt",
      "bad-target.output",
      "broken.output",
      "agent-new.output",
    ] as never)

    const handler = getRouteHandler(handlers, "/api/background-agents")
    const { req, res, next } = createMockReqRes("GET", `/?cwd=${encodeURIComponent(cwd)}`)
    await handler(req, res, next)

    expect(JSON.parse(res.getBody())).toEqual([
      {
        agentId: "agent-new",
        dirName: "proj-new",
        fileName: "parent-new/subagents/agent-new.jsonl",
        parentSessionId: "parent-new",
        modifiedAt: 100_000,
        isActive: true,
        preview: "new array task description",
      },
      {
        agentId: "agent-old",
        dirName: "proj-old",
        fileName: "parent-old/subagents/agent-old.jsonl",
        parentSessionId: "parent-old",
        modifiedAt: 1_000,
        isActive: false,
        preview: "old task description",
      },
    ])
    expect(next).not.toHaveBeenCalled()
  })

  it("skips agent targets with invalid layouts or unreadable output", async () => {
    const cwd = "/tmp/project"
    addOutput(cwd, "shallow.output", {
      symlink: true,
      target: "/projects/proj/parent/subagents",
    })
    addOutput(cwd, "wrong-dir.output", {
      symlink: true,
      target: "/projects/proj/parent/not-subagents/agent-wrong.jsonl",
    })
    addOutput(cwd, "unreadable.output", {
      symlink: true,
      target: "/projects/proj/parent/subagents/agent-unreadable.jsonl",
      statError: true,
    })
    mockedReaddir.mockResolvedValueOnce([
      "shallow.output",
      "wrong-dir.output",
      "unreadable.output",
    ] as never)

    const handler = getRouteHandler(handlers, "/api/background-agents")
    const { req, res, next } = createMockReqRes("GET", `/?cwd=${encodeURIComponent(cwd)}`)
    await handler(req, res, next)

    expect(JSON.parse(res.getBody())).toEqual([])
    expect(next).not.toHaveBeenCalled()
  })

  it("detects live task ports and keeps the newest owner without changing result order", async () => {
    const cwd = "/tmp/project"
    livePorts.add(4321)
    livePorts.add(5678)
    const oldPath = addOutput(cwd, "old.output", {
      content: "[2Kdiscard me\nserver on localhost:4321\nbackup :5678",
      mtimeMs: 1_000,
    })
    const newPath = addOutput(cwd, "new.output", {
      content: "new server on port 4321",
      mtimeMs: 2_000,
    })
    addOutput(cwd, "dead.output", { content: "port 6000", mtimeMs: 3_000 })
    addOutput(cwd, "symlink.output", { content: "port 7000", symlink: true })
    addOutput(cwd, "empty.output", { content: "" })
    addOutput(cwd, "noise.output", { content: "no listening address" })
    mockedReaddir.mockResolvedValueOnce([
      "old.output",
      "new.output",
      "dead.output",
      "symlink.output",
      "empty.output",
      "noise.output",
      "ignored.log",
    ] as never)

    const handler = getRouteHandler(handlers, "/api/background-tasks")
    const { req, res, next } = createMockReqRes("GET", `/?cwd=${encodeURIComponent(cwd)}`)
    await handler(req, res, next)

    expect(JSON.parse(res.getBody())).toEqual([
      {
        id: "new",
        outputPath: newPath,
        ports: [4321],
        portStatus: { 4321: true },
        preview: "new server on port 4321",
      },
      {
        id: "old",
        outputPath: oldPath,
        ports: [4321, 5678],
        portStatus: { 4321: true, 5678: true },
        preview: "server on localhost:4321\nbackup :5678",
      },
    ])
    expect([...sockets.keys()]).toEqual([4321, 5678, 6000])
    expect(sockets.get(4321)?.setTimeout).toHaveBeenCalledWith(500)
    expect(sockets.get(4321)?.destroy).toHaveBeenCalledTimes(1)
    expect(sockets.get(6000)?.destroy).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it("skips malformed, unreadable, empty, and portless regular task outputs", async () => {
    const cwd = "/tmp/project"
    addOutput(cwd, "broken.output", { lstatError: true })
    addOutput(cwd, "unreadable.output", { statError: true })
    addOutput(cwd, "empty.output", { content: "" })
    addOutput(cwd, "invalid-ports.output", { content: "port 99999 and port 0000" })
    addOutput(cwd, "portless.output", { content: "ready without a port" })
    mockedReaddir.mockResolvedValueOnce([
      "broken.output",
      "unreadable.output",
      "empty.output",
      "invalid-ports.output",
      "portless.output",
    ] as never)

    const handler = getRouteHandler(handlers, "/api/background-tasks")
    const { req, res, next } = createMockReqRes("GET", `/?cwd=${encodeURIComponent(cwd)}`)
    await handler(req, res, next)

    expect(JSON.parse(res.getBody())).toEqual([])
    expect(mockedCreateConnection).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
