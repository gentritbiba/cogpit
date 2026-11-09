// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = vi.hoisted(() => ({ filePath: "" }))

vi.mock("../../lib/sessionArchive", () => ({
  archiveReason: () => null,
  readArchive: async () => ({ archived: new Map(), kept: new Set() }),
  setSessionsArchived: vi.fn().mockResolvedValue([]),
}))
vi.mock("../../sessionPaths", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../sessionPaths")>(),
  resolveSessionFilePath: vi.fn(async () => state.filePath),
}))

import type { Middleware } from "../../helpers"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerProjectRoutes } from "../../routes/projects"
import { setDataRoot } from "../../config"
import { agentKindForDirName, formatFor, projectDirNameFor, type AgentFormat } from "../../../shared/session/agents"
import { linkAsyncAnswers } from "../../../shared/session/asyncAnswers"
import { pairAgentMessageReplies } from "../../../shared/session/turnBuilder"
import type { Turn } from "../../../shared/session/types"
import { claudeTranscript, codexTranscript, copilotTranscript } from "./turnPageFixtures"

interface TurnPageResponse {
  headerLines: string[]
  tailLines?: string[]
  lines?: string[]
  byteOffset: number
  totalSize?: number
  end?: number
  hasMore: boolean
  unit: "turns"
  cutTurn: boolean
}

const CLAUDE_DIR = "-repo"
const CODEX_DIR = projectDirNameFor("codex", "/repo")
const COPILOT_DIR = projectDirNameFor("copilot", "/repo")

const cleanups: string[] = []
let root = ""
let handlers: Map<string, Middleware>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-turn-pages-"))
  cleanups.push(root)
  setDataRoot(root)
  handlers = collectRoutes(registerProjectRoutes)
})

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function writeTranscript(lines: readonly string[], trailing = "\n"): Promise<void> {
  state.filePath = join(root, "session.jsonl")
  await writeFile(state.filePath, lines.join("\n") + trailing)
}

async function getPage(dirName: string, query: string): Promise<TurnPageResponse> {
  const { req, res, next } = createMockReqRes("GET", `${dirName}/session.jsonl${query}`)
  await getRouteHandler(handlers, "/api/sessions/")(req, res, next)
  expect(res._getStatus()).toBe(200)
  return JSON.parse(res._getData()) as TurnPageResponse
}

const pageLines = (page: TurnPageResponse) => page.tailLines ?? page.lines ?? []

/** What a reader parses for one page: its header lines, then its own. */
function parsePage(format: AgentFormat, page: TurnPageResponse): Turn[] {
  return format.parse([...page.headerLines, ...pageLines(page)].join("\n")).turns
}

/** The cross-turn passes a reader runs again once pages are joined. */
const joinPages = (turns: Turn[]) => linkAsyncAnswers(pairAgentMessageReplies(turns))

/** Pages from the tail back to the head of the file, oldest first. */
async function pageToHead(dirName: string, params: string): Promise<TurnPageResponse[]> {
  const pages = [await getPage(dirName, `?unit=turns&tail=${params}`)]
  for (let guard = 0; pages[0].hasMore; guard++) {
    if (guard > 400) throw new Error("paging did not terminate")
    const older = await getPage(dirName, `?unit=turns&before=${pages[0].byteOffset}&count=${params}`)
    expect(older.byteOffset).toBeLessThan(pages[0].byteOffset)
    pages.unshift(older)
  }
  return pages
}

const nativeOffsets = (lines: readonly string[]) => {
  let cursor = 0
  return lines.map((line) => {
    const at = cursor
    cursor += Buffer.byteLength(line) + 1
    return at
  })
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const promptLine = (uuid: string, content: string) => JSON.stringify({ type: "user", uuid, message: { role: "user", content } })
const toolCallLines = (call: string, result: string) => [
  JSON.stringify({ type: "assistant", uuid: `a-${call}`, message: { id: `m-${call}`, role: "assistant", model: "m", content: [{ type: "tool_use", id: call, name: "Bash", input: {} }], usage: USAGE } }),
  JSON.stringify({ type: "user", uuid: `r-${call}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: call, content: result }] } }),
]

const FIXTURES: Array<{ name: string; dirName: string; lines: () => string[] }> = [
  { name: "Claude", dirName: CLAUDE_DIR, lines: () => claudeTranscript(48) },
  { name: "Codex", dirName: CODEX_DIR, lines: () => codexTranscript(40) },
  { name: "a Codex sub-agent fork", dirName: CODEX_DIR, lines: () => codexTranscript(40, { forkedAt: 60 }) },
  { name: "Copilot", dirName: COPILOT_DIR, lines: () => copilotTranscript(40) },
]

describe.each(FIXTURES)("turn pages of $name", ({ dirName, lines: makeLines }) => {
  const format = formatFor(agentKindForDirName(dirName))

  it.each([
    ["3 turns, a small budget", "3&maxBytes=65536"],
    ["10 turns, the default budget", "10"],
    ["1 turn, the smallest budget", "1&maxBytes=16384"],
  ])("join into the whole transcript: %s", async (_label, params) => {
    const lines = makeLines()
    await writeTranscript(lines)
    const full = format.parse(lines.join("\n")).turns
    const pages = await pageToHead(dirName, params)

    // Every page holds whole turns, so parsed one by one they are the full parse.
    expect(joinPages(pages.flatMap((page) => parsePage(format, page)))).toEqual(full)
    expect(pages.every((page) => parsePage(format, page).length > 0)).toBe(true)

    // Every page starts at a turn's first line, the oldest right after the
    // header lines, and together with them they hold every line once.
    const offsets = nativeOffsets(lines)
    const cuts = new Set(format.pageCuts(lines.map((line) => JSON.parse(line))).map((cut) => offsets[cut]))
    for (const page of pages.slice(1)) expect(cuts.has(page.byteOffset)).toBe(true)
    const header = pages[0].headerLines
    expect(pages[0].byteOffset).toBe(offsets[header.length])
    const sent = [...header, ...pages.flatMap(pageLines)]
    expect(sent.slice(1)).toEqual(lines.filter((line) => !format.isNoiseLine(line)).slice(1))
    expect(pages.every((page) => !page.cutTurn)).toBe(true)
  })

  it("leaves the tail page's live append the same turns as a full parse", async () => {
    const lines = makeLines()
    const written = lines.slice(0, Math.floor(lines.length * 0.7))
    await writeTranscript(written)
    const tail = await getPage(dirName, "?unit=turns&tail=4&maxBytes=65536")
    expect(tail.end).toBe(tail.totalSize)

    const appended = format.append(format.parse([...tail.headerLines, ...pageLines(tail)].join("\n")), lines.slice(written.length).join("\n"))
    const full = format.parse(lines.join("\n")).turns
    const firstId = appended.turns[0].id
    expect(full.some((turn) => turn.id === firstId)).toBe(true)
    expect(appended.turns).toEqual(full.slice(full.findIndex((turn) => turn.id === firstId)))
  })
})

describe("turn pages", () => {
  it("stop at the requested number of turns when the budget allows", async () => {
    const lines = claudeTranscript(30, () => 1_000)
    await writeTranscript(lines)
    const format = formatFor("claude")
    const tail = await getPage(CLAUDE_DIR, "?unit=turns&tail=4")
    expect(parsePage(format, tail)).toHaveLength(4)
    expect(tail).toMatchObject({ unit: "turns", cutTurn: false, hasMore: true })

    const older = await getPage(CLAUDE_DIR, `?unit=turns&before=${tail.byteOffset}&count=5`)
    expect(parsePage(format, older)).toHaveLength(5)
    expect(parsePage(format, older).at(-1)!.id).not.toBe(parsePage(format, tail)[0].id)
  })

  it("stop at the byte budget, counted on the lines as sent", async () => {
    const lines = Array.from({ length: 30 }, (_, turn) => [promptLine(`p-${turn}`, `prompt ${turn}`), ...toolCallLines(`c-${turn}`, "r".repeat(40_000))]).flat()
    await writeTranscript(lines)
    // 40KB results project to small stubs, so a projected page fits far more turns.
    const native = await getPage(CLAUDE_DIR, "?unit=turns&tail=30&maxBytes=131072")
    const projected = await getPage(CLAUDE_DIR, "?unit=turns&tail=30&maxBytes=131072&projection=results-v1")
    const format = formatFor("claude")
    const sentBytes = (page: TurnPageResponse) => pageLines(page).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    expect(sentBytes(native)).toBeLessThanOrEqual(131072)
    expect(sentBytes(projected)).toBeLessThanOrEqual(131072)
    expect(parsePage(format, projected).length).toBeGreaterThan(parsePage(format, native).length * 3)
  })

  it("hold one whole turn bigger than the budget", async () => {
    const lines = claudeTranscript(6, (index) => (index === 5 ? 600_000 : 1_000))
    await writeTranscript(lines)
    const format = formatFor("claude")
    const tail = await getPage(CLAUDE_DIR, "?unit=turns&tail=10&maxBytes=16384")
    const turns = parsePage(format, tail)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toEqual(format.parse(lines.join("\n")).turns.at(-1))
    expect(tail.cutTurn).toBe(false)
  })

  it("start inside a turn only past the hard cap, and say so", async () => {
    // One turn of ~10MB in 100KB results, after two small ones.
    const lines = claudeTranscript(2, () => 1_000)
    lines.push(promptLine("huge", "huge"))
    for (let call = 0; call < 100; call++) lines.push(...toolCallLines(`c-${call}`, "r".repeat(100_000)))
    await writeTranscript(lines)
    const tail = await getPage(CLAUDE_DIR, "?unit=turns&tail=3")
    expect(tail.cutTurn).toBe(true)
    const sent = pageLines(tail).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    expect(sent).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(sent).toBeGreaterThan(7 * 1024 * 1024)
    expect(tail.byteOffset).toBe(nativeOffsets(lines)[lines.length - pageLines(tail).length])

    // The page above holds the rest of that turn, from its prompt.
    const older = await getPage(CLAUDE_DIR, `?unit=turns&before=${tail.byteOffset}&count=3`)
    expect(JSON.parse(pageLines(older)[0]).uuid).toBe("huge")
  })

  it("do not trust the first boundary of a window read from mid-turn", async () => {
    // The newest turn is small; the one before it is ~600KB of tool calls, so
    // the first 256KB window opens on one of its tool results.
    const lines = claudeTranscript(3, () => 1_000)
    lines.push(promptLine("long", "long turn"))
    for (let call = 0; call < 60; call++) lines.push(...toolCallLines(`c-${call}`, "r".repeat(10_000)))
    lines.push(promptLine("last", "last turn"), ...toolCallLines("c-last", "ok"))
    await writeTranscript(lines)

    const tail = await getPage(CLAUDE_DIR, "?unit=turns&tail=2&maxBytes=16777216")
    expect(JSON.parse(pageLines(tail)[0]).uuid).toBe("long")
    expect(parsePage(formatFor("claude"), tail).map((turn) => turn.id)).toEqual(["long", "last"])
  })

  it("keep a turn's compaction, recap and queued prompt on the turn's own page", async () => {
    const format = formatFor("claude")
    const lines = claudeTranscript(8, () => 1_000)
    await writeTranscript(lines)
    const pages = await pageToHead(CLAUDE_DIR, "1&maxBytes=16384")
    const firstRecords = pages.slice(1).map((page) => JSON.parse(pageLines(page)[0]) as { type: string; subtype?: string })
    expect(firstRecords).toContainEqual(expect.objectContaining({ type: "system", subtype: "compact_boundary" }))
    expect(firstRecords).toContainEqual(expect.objectContaining({ type: "system", subtype: "away_summary" }))
    expect(firstRecords).toContainEqual(expect.objectContaining({ type: "queue-operation" }))
    expect(firstRecords).toContainEqual(expect.objectContaining({ type: "summary" }))
    const turns = pages.flatMap((page) => parsePage(format, page))
    expect(turns.find((turn) => turn.compactionSummary?.includes("summary 5"))).toBeDefined()
    expect(turns.some((turn) => turn.contentBlocks.some((block) => block.kind === "recap"))).toBe(true)
  })

  it("put what comes before the first turn on the first turn's page, past a header that stops short of it", async () => {
    const format = formatFor("codex")
    const lines = codexTranscript(3, {}, () => 1_000)
    // Base instructions longer than the 4KB header read, before the first turn.
    lines.splice(4, 0, JSON.stringify({ timestamp: "2026-10-02T00:00:00.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "i".repeat(6_000) }] } }))
    await writeTranscript(lines)
    const pages = await pageToHead(CODEX_DIR, "1&maxBytes=16384")
    expect(pages.map((page) => parsePage(format, page).length)).toEqual([1, 1, 1])
    expect(pageLines(pages[0])).toContain(lines[4])
    expect(pages[0].hasMore).toBe(false)
  })

  it("keep a Codex compaction with the turn that carries its note", async () => {
    const lines = codexTranscript(5, {}, () => 1_000)
    await writeTranscript(lines)
    const pages = await pageToHead(CODEX_DIR, "1&maxBytes=16384")
    const compactedAt = lines.findIndex((line) => JSON.parse(line).type === "compacted")
    expect(pages.map((page) => page.byteOffset)).toContain(nativeOffsets(lines)[compactedAt])
  })

  it("send only the header lines before the first turn, and never repeat them on a page", async () => {
    // Small turns: the 4KB header read reaches well into the transcript's turns.
    const lines = claudeTranscript(4, () => 100)
    expect(Buffer.byteLength(lines.slice(0, 8).join("\n"))).toBeLessThan(4096)
    await writeTranscript(lines)
    const format = formatFor("claude")
    const tail = await getPage(CLAUDE_DIR, "?unit=turns&tail=1")
    // The title records and the first turn's file snapshot, which comes before its prompt
    expect(tail.headerLines).toEqual(lines.slice(0, 3))
    expect(JSON.parse(lines[3]).type).toBe("user")
    // Without a turn's start in the header, a page parses to its own turns only.
    expect(parsePage(format, tail).map((turn) => turn.id)).toEqual([format.parse(lines.join("\n")).turns.at(-1)!.id])

    const oldest = await getPage(CLAUDE_DIR, "?unit=turns&tail=10")
    expect(oldest).toMatchObject({ byteOffset: nativeOffsets(lines)[3], hasMore: false })
    expect(pageLines(oldest)).toEqual(lines.slice(3).filter((line) => !format.isNoiseLine(line)))
  })

  it("leave a partial last line out of the tail and end before it", async () => {
    const lines = claudeTranscript(4, () => 100)
    const finished = JSON.stringify({ type: "user", uuid: "partial", message: { role: "user", content: "still writing" } })
    const partial = finished.slice(0, 40)
    await writeTranscript([...lines, partial], "")
    const tail = await getPage(CLAUDE_DIR, "?unit=turns&tail=2")
    const offsets = nativeOffsets([...lines, partial])
    expect(tail.end).toBe(offsets[lines.length])
    expect(tail.totalSize).toBe(offsets[lines.length] + partial.length)
    expect(pageLines(tail).at(-1)).toBe(lines.at(-1))

    // Once the line is finished it is the first thing the stream reads from `end`.
    await appendFile(state.filePath, `${finished.slice(40)}\n`)
    const next = await getPage(CLAUDE_DIR, "?unit=turns&tail=1")
    expect(JSON.parse(pageLines(next)[0]).uuid).toBe("partial")
    expect(next.byteOffset).toBe(tail.end)
  })

  it("answer an empty file with an empty page", async () => {
    await writeTranscript([], "")
    expect(await getPage(CLAUDE_DIR, "?unit=turns&tail=10")).toEqual({
      headerLines: [], tailLines: [], byteOffset: 0, totalSize: 0, end: 0, hasMore: false, unit: "turns", cutTurn: false,
    })
  })
})

describe("turn pages parsed one at a time (known limit)", () => {
  // Pins current behaviour, not a goal: the turn builder carries state across
  // turns, so a page without the turn that launched a background agent cannot
  // know the agent's later progress belongs to a background agent.
  it("show a background agent as a foreground one when its launching turn is on another page", async () => {
    const progress = JSON.stringify({
      type: "progress", uuid: "progress-1", parentToolUseID: "bg-1",
      data: { type: "agent_progress", agentId: "agent-1", prompt: "", normalizedMessages: [], message: { type: "assistant", message: { id: "sub-1", role: "assistant", model: "m", content: [{ type: "text", text: "working" }] } } },
    })
    const lines = [
      promptLine("p-1", "launch it"),
      JSON.stringify({ type: "assistant", uuid: "a-bg", message: { id: "m-bg", role: "assistant", model: "m", content: [{ type: "tool_use", id: "bg-1", name: "Agent", input: { prompt: "go", run_in_background: true } }], usage: USAGE } }),
      JSON.stringify({ type: "user", uuid: "r-bg", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bg-1", content: "Async agent launched" }] } }),
      promptLine("p-2", "meanwhile"),
      progress,
      ...toolCallLines("c-2", "ok"),
    ]
    await writeTranscript(lines)
    const format = formatFor("claude")
    const kindOf = (turn: Turn | undefined) => turn?.contentBlocks.find((block) => block.kind === "background_agent" || block.kind === "sub_agent")?.kind

    expect(kindOf(format.parse(lines.join("\n")).turns[1])).toBe("background_agent")
    const tail = await getPage(CLAUDE_DIR, "?unit=turns&tail=1")
    expect(kindOf(parsePage(format, tail)[0])).toBe("sub_agent")
  })
})

describe("line pages without unit=turns", () => {
  it("cap a ?before page at the page budget, counted on the projected lines", async () => {
    const lines = claudeTranscript(60, () => 40_000)
    await writeTranscript(lines)
    const tail = await getPage(CLAUDE_DIR, "?tail=30&projection=results-v1")
    expect(tail).not.toHaveProperty("unit")
    const older = await getPage(CLAUDE_DIR, `?before=${tail.byteOffset}&count=30&projection=results-v1`)
    expect(older).not.toHaveProperty("unit")
    const sent = pageLines(older).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    // The 30-line floor wins over the budget; past it the budget holds.
    expect(pageLines(older).length === 30 || sent <= 512 * 1024).toBe(true)
    expect(sent).toBeLessThan(1024 * 1024)
    const offsets = nativeOffsets(lines)
    const first = offsets.indexOf(older.byteOffset)
    expect(first).toBeGreaterThan(0)
    expect(pageLines(older).map((line) => JSON.parse(line).uuid)).toEqual(
      lines.slice(first, offsets.indexOf(tail.byteOffset)).map((line) => JSON.parse(line)).filter((record) => record.type !== "api-request-blob").map((record) => record.uuid),
    )
  })
})
