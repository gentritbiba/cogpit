// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { writeFile, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = vi.hoisted(() => ({ filePath: "" }))

vi.mock("../../lib/sessionArchive", () => ({
  AUTO_ARCHIVE_AFTER_MS: 14 * 24 * 60 * 60_000,
  subscribeArchiveChanges: () => () => {},
  archiveReason: () => null,
  readArchive: async () => ({ archived: new Map(), kept: new Set() }),
  setSessionsArchived: vi.fn().mockResolvedValue([]),
}))
vi.mock("../../sessionPaths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessionPaths")>()
  return {
    ...actual,
    resolveSessionFilePath: vi.fn(async () => state.filePath),
  }
})

import type { Middleware } from "../../helpers"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerProjectRoutes } from "../../routes/projects"
import { projectDirNameFor } from "../../../shared/session/agent-descriptors"
import { parseCodexSession } from "../../../shared/session/codex"

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

describe("session file paging (?tail / ?before)", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    handlers = collectRoutes(registerProjectRoutes)
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

describe("session file paging past Claude's api-request records", () => {
  it("leaves them out of every page, so they take neither the byte budget nor the line floor", async () => {
    const handlers = collectRoutes(registerProjectRoutes)
    const getJson = async <T,>(query: string): Promise<T> => {
      const { req, res, next } = createMockReqRes("GET", `proj-a/session.jsonl${query}`)
      await getRouteHandler(handlers, "/api/sessions/")(req, res, next)
      expect(res._getStatus()).toBe(200)
      return JSON.parse(res._getData()) as T
    }
    const noise = (i: number) => JSON.stringify({ type: "api-request-blob", hash: `h${i}`, blob: "x".repeat(20_000) })
    const lines = Array.from({ length: 200 }, (_, i) => (i % 2 ? noise(i) : paddedLine(i, 1000)))
    const fixture = await writeSession(lines)
    const kept = fixture.lines.filter((_, i) => i % 2 === 0)

    const tail = await getJson<TailResponse>("?tail=30")
    // 100 x 20KB of noise would otherwise fill the 256KB budget with 12 lines
    expect(tail.tailLines.length).toBeGreaterThan(80)
    expect(tail.tailLines.some((line) => line.includes("api-request"))).toBe(false)

    let paged = tail.tailLines
    let before = tail.byteOffset
    let hasMore = tail.hasMore
    while (hasMore) {
      const page = await getJson<PageResponse>(`?before=${before}&count=30`)
      expect(page.lines.some((line) => line.includes("api-request"))).toBe(false)
      expect(page.byteOffset).toBeLessThan(before)
      paged = [...page.lines, ...paged]
      before = page.byteOffset
      hasMore = page.hasMore
    }
    const seen = new Set(paged)
    expect([...tail.headerLines.filter((line) => !seen.has(line)), ...paged]).toEqual(kept)
  })

  it("pages past a run of them longer than one read window instead of returning an empty page", async () => {
    const handlers = collectRoutes(registerProjectRoutes)
    const getJson = async <T,>(query: string): Promise<T> => {
      const { req, res, next } = createMockReqRes("GET", `proj-a/session.jsonl${query}`)
      await getRouteHandler(handlers, "/api/sessions/")(req, res, next)
      expect(res._getStatus()).toBe(200)
      return JSON.parse(res._getData()) as T
    }
    const noise = (i: number) => JSON.stringify({ type: "api-request-blob", hash: `h${i}`, blob: "x".repeat(50_000) })
    const older = Array.from({ length: 5 }, (_, i) => paddedLine(i, 1000))
    const newer = Array.from({ length: 40 }, (_, i) => paddedLine(100 + i, 1000))
    const fixture = await writeSession([...older, ...Array.from({ length: 130 }, (_, i) => noise(i)), ...newer])

    const tail = await getJson<TailResponse>("?tail=30")
    expect(tail.hasMore).toBe(true)
    const page = await getJson<PageResponse>(`?before=${tail.byteOffset}&count=30`)

    expect(page.lines.length).toBeGreaterThan(0)
    expect(page.byteOffset).toBe(0)
    expect(page.hasMore).toBe(false)
    expect([...page.lines, ...tail.tailLines]).toEqual([...older, ...newer])
    expect(fixture.totalSize).toBeGreaterThan(6 * 1024 * 1024)
  })
})

describe("paging a sub-agent rollout that opens with its parent's copied history", () => {
  const record = (ordinal: number, type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: "2026-10-01T00:00:00.000Z", ordinal, type, payload })
  const message = (ordinal: number, role: "user" | "assistant", text: string) => record(ordinal, "response_item", {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text: `${text} ${"x".repeat(1000)}` }],
  })
  const meta = (start: number) => record(0, "session_meta", {
    id: "child",
    cwd: "/repo",
    parent_thread_id: "parent",
    source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/worker" } } },
    subagent_history_start_ordinal: start,
  })
  const exchange = (from: number, count: number, who: string) =>
    Array.from({ length: count }, (_, i) => message(from + i, i % 2 ? "assistant" : "user", `${who} ${i}`))
  const userMessages = (text: string) => parseCodexSession(text).turns.map((turn) => String(turn.userMessage).split(" ")[0])

  async function tailThenOlderPage(lines: string[]) {
    await writeSession(lines)
    const handlers = collectRoutes(registerProjectRoutes)
    const getJson = async <T,>(query: string): Promise<T> => {
      const { req, res, next } = createMockReqRes("GET", `${projectDirNameFor("codex", "/repo")}/rollout.jsonl${query}`)
      await getRouteHandler(handlers, "/api/sessions/")(req, res, next)
      expect(res._getStatus()).toBe(200)
      return JSON.parse(res._getData()) as T
    }
    const tail = await getJson<TailResponse>("?tail=30&maxBytes=16384")
    const page = await getJson<PageResponse>(`?before=${tail.byteOffset}&count=30`)
    const headerLines = new Set(page.headerLines)
    return { tail, page, olderText: [...page.headerLines, ...page.lines.filter((line) => !headerLines.has(line))].join("\n") }
  }

  it("leaves the copy out of an older page that holds nothing else, as the whole file does", async () => {
    const lines = [meta(61), ...exchange(1, 60, "parent"), ...exchange(61, 30, "child")]
    expect(new Set(userMessages(lines.join("\n")))).toEqual(new Set(["child"]))

    const { tail, page, olderText } = await tailThenOlderPage(lines)
    expect(tail.tailLines).toEqual(lines.slice(61))
    expect(page.byteOffset).toBe(0)
    expect(JSON.parse(page.headerLines[0]).rolloutLastOrdinal).toBe(90)
    expect(page.lines[0]).toBe(page.headerLines[0])
    expect(userMessages(olderText)).toEqual([])
  })

  it("keeps an older page of a converted rollout, whose boundary sits at the end of the file", async () => {
    const lines = [meta(91), ...exchange(1, 90, "own")]
    const { page, olderText } = await tailThenOlderPage(lines)
    expect(JSON.parse(page.headerLines[0]).rolloutLastOrdinal).toBe(90)
    expect(new Set(userMessages(olderText))).toEqual(new Set(["own"]))
  })
})
