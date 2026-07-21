// @vitest-environment node
/**
 * Tests for /api/watch/:dirName/:fileName stream-bus forwarding.
 *
 * Uses the REAL streamBus (pure in-memory) with mocked fs helpers, and
 * verifies the SSE route: snapshot on connect, delta forwarding, cleanup
 * on disconnect, and codex sessions opting out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { mockStat, mockOpen, mockWatch } = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockOpen: vi.fn(),
  mockWatch: vi.fn(),
}))

vi.mock("../../helpers", () => ({
  dirs: { PROJECTS_DIR: "/tmp/projects" },
  isCodexDirName: (d: string) => d.startsWith("codex__"),
  isWithinDir: () => true,
  resolveSessionFilePath: vi.fn(async (dirName: string, fileName: string) => `/tmp/projects/${dirName}/${fileName}`),
  stat: mockStat,
  open: mockOpen,
  watch: mockWatch,
  resolve: (p: string) => p,
}))

import { registerFileWatchRoutes } from "../../routes/files-watch"
import { publish, clear, _resetForTests } from "../../lib/streamBus"
import type { UseFn, Middleware } from "../../helpers"

function getHandler(path: string): Middleware {
  let captured: Middleware | undefined
  const use: UseFn = (p: string, handler: Middleware) => {
    if (p === path) captured = handler
  }
  registerFileWatchRoutes(use)
  if (!captured) throw new Error(`No handler for ${path}`)
  return captured
}

function makeReqRes(urlPath: string) {
  const closeHandlers: (() => void)[] = []
  const req = {
    method: "GET",
    url: urlPath,
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "close") closeHandlers.push(handler)
      return req
    }),
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  }
  const frames: string[] = []
  const res = {
    statusCode: 200,
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    write: vi.fn((chunk: string) => {
      frames.push(chunk)
      return true
    }),
    end: vi.fn(),
  }
  const next = vi.fn()
  const closeConnection = () => closeHandlers.forEach((h) => h())
  return { req, res, next, frames, closeConnection }
}

function parseFrames(frames: string[]): Array<Record<string, unknown>> {
  return frames
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice("data: ".length)))
}

async function connect(urlPath: string) {
  const handler = getHandler("/api/watch/")
  const harness = makeReqRes(urlPath)
  await handler(harness.req as never, harness.res as never, harness.next)
  // allow the async handler body (stat init) to settle
  await new Promise((r) => setTimeout(r, 10))
  return harness
}

const SESSION = "11111111-2222-3333-4444-555555555555"

beforeEach(() => {
  vi.clearAllMocks()
  _resetForTests()
  mockStat.mockResolvedValue({ size: 0, mtimeMs: Date.now() })
  mockOpen.mockResolvedValue({
    read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
  })
  mockWatch.mockReturnValue({ on: vi.fn(), close: vi.fn() })
})

afterEach(() => {
  _resetForTests()
})

describe("/api/watch stream-bus forwarding", () => {
  it("sends a stream_snapshot on connect when a stream is mid-flight", async () => {
    publish(SESSION, { type: "message_start", message: { id: "msg_1" } }, null)
    publish(SESSION, { type: "content_block_start", index: 0, content_block: { type: "text" } }, null)
    publish(SESSION, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }, null)

    const { frames, closeConnection } = await connect(`/proj-a/${SESSION}.jsonl`)
    const events = parseFrames(frames)
    const snapshot = events.find((e) => e.type === "stream_snapshot") as
      | { messages: Array<{ messageId: string; blocks: Array<{ text: string }> }> }
      | undefined

    expect(snapshot).toBeDefined()
    expect(snapshot!.messages[0].messageId).toBe("msg_1")
    expect(snapshot!.messages[0].blocks[0].text).toBe("partial")
    closeConnection()
  })

  it("forwards stream_delta and stream_clear events while connected", async () => {
    const { frames, closeConnection } = await connect(`/proj-a/${SESSION}.jsonl`)

    publish(SESSION, { type: "message_start", message: { id: "msg_2" } }, null)
    publish(SESSION, { type: "content_block_start", index: 0, content_block: { type: "text" } }, null)
    publish(SESSION, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "live!" } }, null)
    await new Promise((r) => setTimeout(r, 100)) // let the bus flush
    clear(SESSION)

    const events = parseFrames(frames)
    const deltas = events.filter((e) => e.type === "stream_delta")
    expect(deltas.length).toBeGreaterThan(0)
    const all = deltas.flatMap((d) => d.events as Array<{ delta: string }>)
    expect(all.some((d) => d.delta === "live!")).toBe(true)
    expect(events.some((e) => e.type === "stream_clear")).toBe(true)
    closeConnection()
  })

  it("stops forwarding after the client disconnects", async () => {
    const { frames, closeConnection } = await connect(`/proj-a/${SESSION}.jsonl`)
    closeConnection()
    const countAtClose = frames.length

    publish(SESSION, { type: "message_start", message: { id: "msg_3" } }, null)
    publish(SESSION, { type: "content_block_start", index: 0, content_block: { type: "text" } }, null)
    await new Promise((r) => setTimeout(r, 100))

    expect(frames.length).toBe(countAtClose)
  })

  it("does not subscribe codex sessions to the bus", async () => {
    publish(SESSION, { type: "message_start", message: { id: "msg_4" } }, null)
    publish(SESSION, { type: "content_block_start", index: 0, content_block: { type: "text" } }, null)

    const { frames, closeConnection } = await connect(`/codex__proj/${SESSION}.jsonl`)
    const events = parseFrames(frames)
    expect(events.some((e) => e.type === "stream_snapshot")).toBe(false)
    closeConnection()
  })

  it("replays lines written after the client snapshot offset", async () => {
    const line = '{"n":1}\n'
    mockStat.mockResolvedValue({ size: Buffer.byteLength(line), mtimeMs: Date.now() })
    mockOpen.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer) => {
        buffer.write(line)
        return { bytesRead: Buffer.byteLength(line) }
      }),
      close: vi.fn().mockResolvedValue(undefined),
    })

    const { frames, closeConnection } = await connect(`/codex__proj/${SESSION}.jsonl?offset=0`)
    const events = parseFrames(frames)
    expect(events).toContainEqual({ type: "lines", lines: [line.trimEnd()] })
    closeConnection()
  })

  it("keeps the original end-of-file baseline when no offset is supplied", async () => {
    const line = '{"existing":true}\n'
    mockStat.mockResolvedValue({ size: Buffer.byteLength(line), mtimeMs: Date.now() })

    const { frames, closeConnection } = await connect(`/codex__proj/${SESSION}.jsonl`)
    const events = parseFrames(frames)

    expect(events).toContainEqual({
      type: "init",
      offset: Buffer.byteLength(line),
      recentlyActive: true,
    })
    expect(mockOpen).not.toHaveBeenCalled()
    closeConnection()
  })

  it("bounds replay reads and preserves UTF-8 split across chunks", async () => {
    const chunkBytes = 256 * 1024
    const line = `${"a".repeat(chunkBytes - 1)}🙂`
    const source = Buffer.from(`${line}\n`)
    const readSizes: number[] = []
    mockStat.mockResolvedValue({ size: source.length, mtimeMs: Date.now() })
    mockOpen.mockImplementation(async () => ({
      read: vi.fn(
        async (buffer: Buffer, _bufferOffset: number, length: number, position: number) => {
          readSizes.push(buffer.length)
          const bytesRead = source.copy(buffer, 0, position, position + length)
          return { bytesRead }
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    }))

    const { frames, closeConnection } = await connect(
      `/codex__proj/${SESSION}.jsonl?offset=0`,
    )
    await vi.waitFor(() => {
      const replayedLines = parseFrames(frames)
        .filter((event) => event.type === "lines")
        .flatMap((event) => event.lines as string[])
      expect(replayedLines).toEqual([line])
    })

    expect(readSizes.length).toBeGreaterThan(1)
    expect(Math.max(...readSizes)).toBeLessThanOrEqual(chunkBytes)
    closeConnection()
  })
})

describe("/api/task-output streaming", () => {
  it("serializes and bounds reads while delivering the complete output", async () => {
    const totalBytes = 300_000
    const readSizes: number[] = []
    mockStat.mockResolvedValue({ size: totalBytes, mtimeMs: Date.now() })
    mockOpen.mockImplementation(async () => ({
      read: vi.fn(async (buffer: Buffer) => {
        readSizes.push(buffer.length)
        buffer.fill("x")
        return { bytesRead: buffer.length }
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }))

    const handler = getHandler("/api/task-output")
    const harness = makeReqRes(
      `/?path=${encodeURIComponent("/tmp/claude-cogpit-test/task.output")}`,
    )
    await handler(harness.req as never, harness.res as never, harness.next)
    await vi.waitFor(() => expect(readSizes.reduce((sum, size) => sum + size, 0)).toBe(totalBytes))

    expect(readSizes.length).toBeGreaterThan(1)
    expect(Math.max(...readSizes)).toBeLessThanOrEqual(256 * 1024)
    expect(harness.frames.length).toBe(readSizes.length)
    harness.closeConnection()
  })

  it("preserves a UTF-8 character split across read chunks", async () => {
    const chunkBytes = 256 * 1024
    const source = Buffer.concat([
      Buffer.alloc(chunkBytes - 1, "a"),
      Buffer.from("🙂"),
      Buffer.from("z"),
    ])
    mockStat.mockResolvedValue({ size: source.length, mtimeMs: Date.now() })
    mockOpen.mockImplementation(async () => ({
      read: vi.fn(
        async (buffer: Buffer, _bufferOffset: number, length: number, position: number) => {
          const bytesRead = source.copy(buffer, 0, position, position + length)
          return { bytesRead }
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    }))

    const handler = getHandler("/api/task-output")
    const harness = makeReqRes(
      `/?path=${encodeURIComponent("/tmp/claude-cogpit-test/utf8.output")}`,
    )
    await handler(harness.req as never, harness.res as never, harness.next)
    await vi.waitFor(() => {
      const text = parseFrames(harness.frames)
        .filter((event) => event.type === "output")
        .map((event) => event.text)
        .join("")
      expect(text).toBe(source.toString("utf8"))
    })
    harness.closeConnection()
  })
})
