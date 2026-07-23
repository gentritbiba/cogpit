// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { writeFile, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = vi.hoisted(() => ({ filePath: "" }))

vi.mock("../../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../helpers")>()
  return {
    ...actual,
    resolveSessionFilePath: vi.fn(async () => state.filePath),
  }
})

import type { UseFn, Middleware } from "../../helpers"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"
import { registerProjectRoutes } from "../../routes/projects"

interface TailResponse {
  headerLines: string[]
  tailLines: string[]
  byteOffset: number
  totalSize: number
  hasMore: boolean
}

interface PageResponse {
  headerLines: string[]
  lines: string[]
  byteOffset: number
  hasMore: boolean
}

interface Fixture {
  lines: string[]
  offsets: number[]
  totalSize: number
  offsetOf: (line: string) => number
}

const cleanups: string[] = []

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** JSONL line of exactly `targetBytes` bytes (ASCII payload). */
function paddedLine(i: number, targetBytes: number): string {
  const wrapper = JSON.stringify({ i, blob: "" })
  return JSON.stringify({ i, blob: "x".repeat(Math.max(0, targetBytes - wrapper.length)) })
}

async function writeSession(lines: string[]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "cogpit-paging-test-"))
  cleanups.push(dir)
  const filePath = join(dir, "session.jsonl")
  await writeFile(filePath, lines.join("\n") + "\n")
  state.filePath = filePath

  let cursor = 0
  const offsets = lines.map((line) => {
    const at = cursor
    cursor += Buffer.byteLength(line, "utf8") + 1
    return at
  })
  const byLine = new Map(lines.map((line, i) => [line, offsets[i]]))
  return {
    lines,
    offsets,
    totalSize: cursor,
    offsetOf: (line) => {
      const offset = byLine.get(line)
      if (offset === undefined) throw new Error(`line not in fixture: ${line.slice(0, 80)}`)
      return offset
    },
  }
}

function createMockReqRes(method: string, url: string) {
  let endData = ""
  let statusCode = 200
  const req = { method, url, socket: { remoteAddress: "127.0.0.1" }, headers: {} }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { endData = data || "" }),
    _getData: () => endData,
    _getStatus: () => statusCode,
  }
  const next = vi.fn()
  return { req: asIncomingMessage(req), res: asServerResponse(res), next }
}

describe("session file paging (?tail / ?before)", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerProjectRoutes(use)
  })

  async function getJson<T>(query: string): Promise<T> {
    const handler = getRouteHandler(handlers, "/api/sessions/")
    const { req, res, next } = createMockReqRes("GET", `proj-a/session.jsonl${query}`)
    await handler(req, res, next)
    expect(res._getStatus()).toBe(200)
    return JSON.parse(res._getData()) as T
  }

  /**
   * Pages backward from the tail until hasMore=false, asserting byte-exact
   * offsets and strict progress along the way, then reconstructs the file the
   * way clients do: header lines not covered by pages, then paged lines.
   */
  async function pageToStart(fixture: Fixture, tailQuery: string, count: number) {
    const tail = await getJson<TailResponse>(tailQuery)
    if (tail.tailLines.length > 0) {
      expect(tail.byteOffset).toBe(fixture.offsetOf(tail.tailLines[0]))
    }

    const pages: PageResponse[] = []
    let before = tail.byteOffset
    let hasMore = tail.hasMore
    let guard = 0
    while (hasMore) {
      if (++guard > 60) throw new Error("paging did not terminate")
      const page = await getJson<PageResponse>(`?before=${before}&count=${count}`)
      expect(page.byteOffset).toBeLessThan(before)
      if (page.lines.length > 0) {
        expect(page.byteOffset).toBe(fixture.offsetOf(page.lines[0]))
      }
      pages.unshift(page)
      before = page.byteOffset
      hasMore = page.hasMore
    }

    const paged = pages.flatMap((p) => p.lines)
    const all = [...paged, ...tail.tailLines]
    const seen = new Set(all)
    expect(seen.size).toBe(all.length) // no duplicates across pages
    const reconstructed = [...tail.headerLines.filter((l) => !seen.has(l)), ...all]
    return { tail, pages, reconstructed }
  }

  it("keeps at least 30 tail lines when a fat line would blow the byte budget", async () => {
    // Fat line sits inside the newest 30: the 256KB default budget alone would
    // trim the page down to the 9 small lines after it.
    const fixture = await writeSession([
      ...Array.from({ length: 50 }, (_, i) => paddedLine(i, 1000)),
      paddedLine(50, 500_000),
      ...Array.from({ length: 9 }, (_, i) => paddedLine(51 + i, 1000)),
    ])

    const tail = await getJson<TailResponse>("?tail=30")

    expect(tail.tailLines).toEqual(fixture.lines.slice(30))
    expect(tail.tailLines.length).toBe(30)
    expect(tail.byteOffset).toBe(fixture.offsets[30])
    expect(tail.totalSize).toBe(fixture.totalSize)
    expect(tail.hasMore).toBe(true)
  })

  it("extends the tail window when it holds fewer complete lines than the floor", async () => {
    // tail=1 reads a 64KB window that lands inside the 500KB newest line —
    // zero complete lines without the backward extension.
    const fixture = await writeSession([
      ...Array.from({ length: 100 }, (_, i) => paddedLine(i, 1000)),
      paddedLine(100, 500_000),
    ])

    const tail = await getJson<TailResponse>("?tail=1")

    expect(tail.tailLines.length).toBe(30)
    expect(tail.tailLines).toEqual(fixture.lines.slice(71))
    expect(tail.byteOffset).toBe(fixture.offsets[71])
    expect(tail.tailLines.at(-1)).toBe(fixture.lines.at(-1))
  })

  it("returns every line when the file has fewer than the floor", async () => {
    const fixture = await writeSession(
      Array.from({ length: 5 }, (_, i) => paddedLine(i, 100)),
    )

    const tail = await getJson<TailResponse>("?tail=30")

    expect(tail.tailLines).toEqual(fixture.lines)
    expect(tail.byteOffset).toBe(0)
    expect(tail.hasMore).toBe(false)
  })

  it("keeps the newest line when a single line exceeds every budget and window", async () => {
    const fixture = await writeSession([
      paddedLine(0, 100),
      paddedLine(1, 100),
      paddedLine(2, 600_000),
    ])

    const tail = await getJson<TailResponse>("?tail=1&maxBytes=16384")

    expect(tail.tailLines).toEqual(fixture.lines)
    expect(tail.tailLines.at(-1)).toBe(fixture.lines[2])
    expect(tail.byteOffset).toBe(0)
  })

  it("honors the min-line floor over a small maxBytes budget", async () => {
    const fixture = await writeSession(
      Array.from({ length: 60 }, (_, i) => paddedLine(i, 1000)),
    )

    const tail = await getJson<TailResponse>("?tail=30&maxBytes=16384")

    // 16KB budget alone would keep ~16 lines; the floor guarantees 30.
    expect(tail.tailLines.length).toBe(30)
    expect(tail.tailLines).toEqual(fixture.lines.slice(30))
    expect(tail.byteOffset).toBe(fixture.offsets[30])
  })

  it("guarantees at least 30 lines per ?before page around a fat line", async () => {
    const fixture = await writeSession([
      ...Array.from({ length: 200 }, (_, i) => paddedLine(i, 1000)),
      paddedLine(200, 500_000),
      ...Array.from({ length: 199 }, (_, i) => paddedLine(201 + i, 1000)),
    ])

    const { tail, pages, reconstructed } = await pageToStart(fixture, "?tail=30&maxBytes=16384", 1)

    expect(tail.tailLines.length).toBeGreaterThanOrEqual(30)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      // Every page except the final one (hasMore=false, whatever remains
      // before it lives in headerLines) meets the floor.
      if (page.hasMore) {
        expect(page.lines.length).toBeGreaterThanOrEqual(30)
      }
    }
    expect(reconstructed).toEqual(fixture.lines)
  })

  it("reconstructs the exact file from tail + before pages with no gaps or dupes", async () => {
    const fixture = await writeSession([
      ...Array.from({ length: 100 }, (_, i) => paddedLine(i, 1000)),
      paddedLine(100, 500_000),
      ...Array.from({ length: 99 }, (_, i) => paddedLine(101 + i, 1000)),
    ])

    const { reconstructed } = await pageToStart(fixture, "?tail=30", 5)

    expect(reconstructed).toEqual(fixture.lines)
  })

  it("keeps offsets byte-exact with multibyte UTF-8 spanning window boundaries", async () => {
    // ~270 bytes per line (2- and 4-byte code points), ~81KB total: count=1
    // pages use 64KB windows whose starts land mid-line, mid-code-point.
    const fixture = await writeSession(
      Array.from({ length: 300 }, (_, i) =>
        JSON.stringify({ i, text: "é🎉".repeat(40) + "-" + i })),
    )

    const { tail, reconstructed } = await pageToStart(fixture, "?tail=30&maxBytes=16384", 1)

    expect(tail.byteOffset).toBe(fixture.offsets[300 - tail.tailLines.length])
    expect(reconstructed).toEqual(fixture.lines)
  })

  it("returns fewer lines at the hard cap but keeps progressing", async () => {
    // 300KB lines: a 2MB tail window and 4MB before window can never satisfy
    // the 30-line floor, so pages come up short — but never stall.
    const fixture = await writeSession(
      Array.from({ length: 20 }, (_, i) => paddedLine(i, 300_000)),
    )

    const { tail, pages, reconstructed } = await pageToStart(fixture, "?tail=1&maxBytes=16384", 1)

    expect(tail.tailLines.length).toBeGreaterThanOrEqual(1)
    expect(tail.tailLines.length).toBeLessThan(30)
    expect(tail.hasMore).toBe(true)
    for (const page of pages) {
      expect(page.lines.length).toBeGreaterThanOrEqual(1)
      expect(page.lines.length).toBeLessThan(30)
    }
    expect(reconstructed).toEqual(fixture.lines)
  })
})
