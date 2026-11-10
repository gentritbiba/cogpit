import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installDirsMock, mockDbPath, mockDirs, writeSession } from "../fixtures"

installDirsMock()

const { searchSessions } = await import("../../commands/search")
const { indexStats, indexSync } = await import("../../commands/index-cmd")
const { rebuildToolIndex, syncTranscripts } = await import("../../lib/sync")
const { openMemoryStore } = await import("../../lib/memory-store")
const { SearchIndex } = await import("../../lib/search-index")

let tmpDir: string
let projectDir: string

const DAY = 24 * 60 * 60 * 1000

/** A transcript with a prompt, a reply and one tool call, all `ageDays` old. */
function writeAgedSession(name: string, prompt: string, reply: string, toolInput: string, ageDays: number): string {
  const timestamp = new Date(Date.now() - ageDays * DAY).toISOString()
  const filePath = join(projectDir, `${name}.jsonl`)
  writeFileSync(filePath, [
    { type: "user", uuid: `${name}-u1`, timestamp, sessionId: name, cwd: "/work/aged", message: { role: "user", content: prompt } },
    { type: "assistant", uuid: `${name}-a1`, timestamp, message: { role: "assistant", model: "test-model", id: "m1", content: [
      { type: "text", text: reply },
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: toolInput } },
    ], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "user", uuid: `${name}-u2`, timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } },
  ].map((record) => JSON.stringify(record)).join("\n"))
  const at = new Date(Date.now() - ageDays * DAY)
  utimesSync(filePath, at, at)
  return filePath
}

type Response = {
  totalHits: number
  semantic: string
  semanticReason?: string
  warnings?: string[]
  results: Array<{ sessionId: string; cwd: string; title?: string; hits: Array<Record<string, unknown>> }>
}

async function search(query: string, options: Parameters<typeof searchSessions>[1] = {}): Promise<Response> {
  const result = await searchSessions(query, options)
  expect(result).not.toHaveProperty("error")
  return result as unknown as Response
}

describe("search with the memory store", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-search-memory-"))
    mockDirs.PROJECTS_DIR = join(tmpDir, "projects")
    mockDirs.CODEX_SESSIONS_DIR = join(tmpDir, "codex")
    mockDirs.COPILOT_SESSIONS_DIR = join(tmpDir, "copilot")
    mockDirs.ACP_PROJECTS_DIR = join(tmpDir, "acp")
    mockDbPath.value = join(tmpDir, "index", "search-index.db")
    process.env.COGPIT_MEMORY_DIR = join(tmpDir, "memory")
    projectDir = join(mockDirs.PROJECTS_DIR, "-work-aged")
    mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("searches prose across all time but tool calls within five days unless --max-age is given", async () => {
    writeAgedSession("old", "Why did we pick SQLite for the decision log?", "Because WAL handles two writers.", "sqlite3 decision.db", 40)

    const prose = await search("decision log")
    expect(prose.results.map((result) => result.sessionId)).toEqual(["old"])
    expect(prose.results[0].hits.every((hit) => hit.kind !== "tool_input")).toBe(true)

    expect((await search("decision.db")).totalHits).toBe(0)
    expect((await search("decision.db", { maxAge: "60d" })).results[0].hits[0]).toMatchObject({ kind: "tool_input", location: "turn/0/toolCall/tool-1/input", turn: 0 })
    expect((await search("decision log", { maxAge: "30d" })).totalHits).toBe(0)
  })

  it("ranks a question by its rarer words and describes each hit", async () => {
    writeAgedSession("ranked", "How should the memory store handle archived transcripts?", "It keeps their chunks and marks hits archived.", "ls", 1)
    writeAgedSession("noise", "The store is open", "Fine.", "ls", 1)

    const response = await search("what happens to archived transcripts in the memory store?")
    expect(response.semantic).toBe("unavailable")
    expect(response.semanticReason).toBeString()
    expect(response.results[0]).toMatchObject({ sessionId: "ranked", cwd: "/work/aged", title: "How should the memory store handle archived transcripts?" })
    expect(response.results[0].hits[0]).toMatchObject({
      location: "turn/0/userMessage",
      kind: "user",
      match: "keyword",
      turn: 0,
      matchCount: 4,
    })
    expect(response.results[0].hits[0].score).toBeGreaterThan(0)
    expect(response.results[0].hits[0].timestamp).toBeString()
  })

  it("keeps prose of a deleted transcript and marks it archived", async () => {
    const path = writeAgedSession("gone", "Remember the rollback runbook", "Step one: freeze deploys.", "rollback --dry-run", 1)
    await search("rollback runbook")
    rmSync(path)

    const response = await search("rollback runbook")
    expect(response.results).toHaveLength(1)
    expect(response.results[0].hits[0]).toMatchObject({ archived: true, text: "Remember the rollback runbook" })
    expect((await search("--dry-run")).totalHits).toBe(0)
  })

  it("finds text only a subagent's own transcript has, with the agent to drill into", async () => {
    writeSession(projectDir, "parent.jsonl", { sessionId: "parent", userMessage: "unrelated" })
    const subDir = join(projectDir, "parent", "subagents")
    mkdirSync(subDir, { recursive: true })
    writeSession(subDir, "agent-xyz.jsonl", { sessionId: "parent", userMessage: "orphaned subagent finding" })

    const response = await search("orphaned subagent finding")
    expect(response.results.map((result) => result.sessionId)).toEqual(["parent"])
    expect(response.results[0].hits[0]).toMatchObject({ location: "agent/xyz/turn/0/userMessage", agent: "xyz", turn: 0 })
  })

  it("keeps answering prose from the tool index for transcripts the memory store has not taken in yet", async () => {
    const backlog = writeAgedSession("backlog", "The flaky websocket reconnect", "Backoff fixed it.", "ls", 1)
    const synced = Array.from({ length: 7 }, (_, n) => writeAgedSession(`synced-${n}`, `websocket reconnect note ${n}`, "Fine.", "ls", 1))
    const index = new SearchIndex(join(tmpDir, "index.db"))
    const memory = openMemoryStore()
    try {
      // The backlog's rows are the oldest, so newer synced prose would fill the candidate window first.
      for (const path of [backlog, ...synced]) index.indexFile(path)
      syncTranscripts({ index: null, memory })
      memory.db.exec(`DELETE FROM chunks WHERE file_id = (SELECT id FROM source_files WHERE path LIKE '%backlog.jsonl')`)
      memory.db.exec(`DELETE FROM source_files WHERE path LIKE '%backlog.jsonl'`)

      const result = await searchSessions("websocket reconnect", { limit: 2 }, index, memory) as unknown as Response
      expect(result.results.map((entry) => entry.sessionId)).toContain("backlog")
      const proseHits = result.results.flatMap((entry) => entry.hits)
      expect(proseHits.filter((hit) => hit.kind === "user")).toHaveLength(1)
      expect(result.totalHits).toBe(8)
    } finally {
      index.close()
      memory.close()
    }
  })

  it("rejects a bad --max-age instead of ignoring it", async () => {
    expect(await searchSessions("anything", { maxAge: "5 days" })).toEqual({ error: expect.stringContaining("Invalid --max-age") })
  })
})

describe("index sync", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-index-sync-"))
    mockDirs.PROJECTS_DIR = join(tmpDir, "projects")
    mockDirs.CODEX_SESSIONS_DIR = join(tmpDir, "codex")
    mockDirs.COPILOT_SESSIONS_DIR = join(tmpDir, "copilot")
    mockDirs.ACP_PROJECTS_DIR = join(tmpDir, "acp")
    mockDbPath.value = join(tmpDir, "index", "search-index.db")
    process.env.COGPIT_MEMORY_DIR = join(tmpDir, "memory")
    projectDir = join(mockDirs.PROJECTS_DIR, "-work-aged")
    mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("fills both stores from one parse and does nothing when nothing changed", async () => {
    writeAgedSession("one", "first prompt", "first reply", "ls", 1)
    writeAgedSession("two", "second prompt", "second reply", "pwd", 2)

    const first = await indexSync({ dbPath: mockDbPath.value })
    expect(first).toMatchObject({ status: "synced", sync: { parsed: 2, toolIndexFiles: 2, memoryFiles: 2 }, memory: { sessions: 2, chunks: 4 } })

    writeAgedSession("three", "third prompt", "third reply", "id", 0)
    const second = await indexSync({ dbPath: mockDbPath.value })
    expect(second).toMatchObject({ sync: { files: 3, parsed: 1, toolIndexFiles: 1, memoryFiles: 1, pending: 0 } })
    expect(await indexSync({ dbPath: mockDbPath.value })).toMatchObject({ sync: { parsed: 0 } })

    expect(await indexStats(mockDbPath.value)).toMatchObject({ indexedFiles: 3, memory: { sessions: 3, chunks: 6, archivedFiles: 0 } })
  })

  it("creates the store owner-only", () => {
    openMemoryStore().close()
    const dir = process.env.COGPIT_MEMORY_DIR!
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, "memory.db")).mode & 0o777).toBe(0o600)
  })

  it("stops starting files once the time budget is spent, newest first", () => {
    writeAgedSession("old", "a", "b", "ls", 3)
    writeAgedSession("new", "c", "d", "ls", 0)
    const memory = openMemoryStore()
    try {
      expect(syncTranscripts({ index: null, memory, budgetMs: -1 })).toMatchObject({ files: 2, parsed: 0, pending: 2 })
      expect(syncTranscripts({ index: null, memory })).toMatchObject({ parsed: 2, pending: 0 })
    } finally {
      memory.close()
    }
  })
})

describe("search-time sync", () => {
  const T0 = Date.parse("2026-11-10T12:00:00.000Z")

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-search-sync-"))
    mockDirs.PROJECTS_DIR = join(tmpDir, "projects")
    mockDirs.CODEX_SESSIONS_DIR = join(tmpDir, "codex")
    mockDirs.COPILOT_SESSIONS_DIR = join(tmpDir, "copilot")
    mockDirs.ACP_PROJECTS_DIR = join(tmpDir, "acp")
    mockDbPath.value = join(tmpDir, "index", "search-index.db")
    process.env.COGPIT_MEMORY_DIR = join(tmpDir, "memory")
    projectDir = join(mockDirs.PROJECTS_DIR, "-work-aged")
    mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  let grown = 0

  /** A session keeps writing: one more line and a newer mtime, even within the same millisecond. */
  function grow(path: string): void {
    appendFileSync(path, `\n${JSON.stringify({ type: "user", uuid: `more-${Math.random()}`, timestamp: new Date().toISOString(), message: { role: "user", content: "more" } })}`)
    const at = new Date(Date.now() + ++grown)
    utimesSync(path, at, at)
  }

  function withMemory<T>(run: (memory: ReturnType<typeof openMemoryStore>) => T): T {
    const memory = openMemoryStore()
    try {
      return run(memory)
    } finally {
      memory.close()
    }
  }

  it("syncs transcripts it has never seen before ones that changed since, each newest first", () => {
    const known = writeAgedSession("known", "a", "b", "ls", 3)
    withMemory((memory) => syncTranscripts({ index: null, memory, now: () => T0 }))
    grow(known)
    writeAgedSession("fresh-old", "c", "d", "ls", 2)
    writeAgedSession("fresh-new", "e", "f", "ls", 1)
    let tick = T0 + 120_000
    withMemory((memory) => {
      expect(syncTranscripts({ index: null, memory, backOff: true, budgetMs: 600, now: () => tick++ })).toMatchObject({ parsed: 3, pending: 0 })
      const order = [...memory.syncedFiles()].sort((a, b) => a[1].syncedAtMs - b[1].syncedAtMs).map(([path]) => path.split("/").pop())
      expect(order).toEqual(["fresh-new.jsonl", "fresh-old.jsonl", "known.jsonl"])
    })
  })

  it("re-syncs a transcript that keeps changing at most once per max(1 min, 20 × its last sync)", () => {
    const path = writeAgedSession("busy", "a", "b", "ls", 0)
    withMemory((memory) => syncTranscripts({ index: null, memory, now: () => T0 }))
    grow(path)
    withMemory((memory) => {
      const at = (offset: number) => syncTranscripts({ index: null, memory, backOff: true, now: () => T0 + offset })
      expect(at(59_000)).toMatchObject({ parsed: 0, pending: 1, unindexed: 0 })
      memory.db.prepare("UPDATE source_files SET sync_ms = 10000").run()
      expect(at(150_000)).toMatchObject({ parsed: 0, pending: 1 })
      expect(at(200_000)).toMatchObject({ parsed: 1, pending: 0 })
      expect(memory.syncedFiles().get(path)?.syncedAtMs).toBe(T0 + 200_000)
    })
  })

  it("does not start a file expected to take longer than the time left", () => {
    const slow = writeAgedSession("slow", "a", "b", "ls", 1)
    withMemory((memory) => syncTranscripts({ index: null, memory, now: () => T0 }))
    grow(slow)
    writeAgedSession("big", "x".repeat(1_500_000), "y", "ls", 2)
    withMemory((memory) => {
      memory.db.prepare("UPDATE source_files SET sync_ms = 500").run()
      // A fixed clock leaves the whole budget: the known file is expected to take 500 ms, the new one about 150 ms for its 1.5 MB.
      const sync = (budgetMs: number) => syncTranscripts({ index: null, memory, budgetMs, now: () => T0 + 600_000 })
      expect(sync(100)).toMatchObject({ parsed: 0, pending: 2, unindexed: 1 })
      expect(sync(200)).toMatchObject({ parsed: 1, pending: 1, unindexed: 0 })
      memory.db.prepare("UPDATE source_files SET sync_ms = 500").run()
      expect(sync(600)).toMatchObject({ parsed: 1, pending: 0 })
    })
  })

  it("syncs the asked-for session and its subagents whatever the budget and back-off", () => {
    const parent = writeAgedSession("own", "a", "b", "ls", 0)
    const subagentDir = join(projectDir, "own", "subagents")
    mkdirSync(subagentDir, { recursive: true })
    const subagent = join(subagentDir, "agent-b1.jsonl")
    writeFileSync(subagent, JSON.stringify({ type: "user", uuid: "s1", timestamp: new Date().toISOString(), sessionId: "own", cwd: "/work/aged", message: { role: "user", content: "child task" } }))
    const other = writeAgedSession("other", "c", "d", "ls", 0)
    withMemory((memory) => syncTranscripts({ index: null, memory, now: () => T0 }))
    for (const path of [parent, subagent, other]) grow(path)
    withMemory((memory) => {
      expect(syncTranscripts({ index: null, memory, backOff: true, budgetMs: -1, sessionId: "own", now: () => T0 + 1_000 }))
        .toMatchObject({ parsed: 2, pending: 1, unindexed: 0 })
      const synced = memory.syncedFiles()
      expect([parent, subagent, other].map((path) => synced.get(path)?.syncedAtMs)).toEqual([T0 + 1_000, T0 + 1_000, T0])
    })
  })

  it("fills a missing tool index within the budget, counting its files as never indexed", () => {
    writeAgedSession("one", "a", "b", "ls", 1)
    writeAgedSession("two", "c", "d", "ls", 2)
    withMemory((memory) => syncTranscripts({ index: null, memory }))
    const index = new SearchIndex(join(tmpDir, "fresh-index.db"))
    try {
      withMemory((memory) => {
        expect(syncTranscripts({ index, memory, backOff: true, budgetMs: -1 })).toMatchObject({ parsed: 0, pending: 2, unindexed: 2 })
        expect(syncTranscripts({ index, memory, backOff: true, budgetMs: 600 })).toMatchObject({ parsed: 2, toolIndexFiles: 2, memoryFiles: 0, pending: 0 })
      })
    } finally {
      index.close()
    }
  })

  it("backs off on the tool index alone, from when it indexed a file, when the memory store is unavailable", () => {
    const path = writeAgedSession("busy", "a", "b", "ls", 1)
    const index = new SearchIndex(join(tmpDir, "tool-only.db"))
    try {
      syncTranscripts({ index, memory: null })
      grow(path)
      expect(syncTranscripts({ index, memory: null, backOff: true, budgetMs: 600 })).toMatchObject({ parsed: 0, pending: 1, unindexed: 0 })
      expect(syncTranscripts({ index, memory: null, backOff: true, budgetMs: 600, now: () => Date.now() + 120_000 })).toMatchObject({ parsed: 1, pending: 0 })
    } finally {
      index.close()
    }
  })

  it("treats a file an older tool index recorded without an index time as due once", () => {
    const path = writeAgedSession("busy", "a", "b", "ls", 1)
    const dbPath = join(tmpDir, "old-index.db")
    const index = new SearchIndex(dbPath)
    try {
      syncTranscripts({ index, memory: null })
      index["db"].exec("UPDATE indexed_files SET indexed_at = NULL")
      grow(path)
      expect(syncTranscripts({ index, memory: null, backOff: true, budgetMs: 600 })).toMatchObject({ parsed: 1 })
      grow(path)
      expect(syncTranscripts({ index, memory: null, backOff: true, budgetMs: 600 })).toMatchObject({ parsed: 0, pending: 1 })
    } finally {
      index.close()
    }
  })

  it("records the whole per-file time when a full rebuild feeds the memory store", () => {
    const path = writeAgedSession("one", "a", "b", "ls", 1)
    const index = new SearchIndex(join(tmpDir, "rebuilt.db"))
    const buildFull = index.buildFull.bind(index)
    index.buildFull = (onParsed) => buildFull((file, session, elapsedMs) => onParsed?.(file, session, elapsedMs + 5_000))
    try {
      withMemory((memory) => {
        rebuildToolIndex(index, memory)
        expect(memory.syncedFiles().get(path)?.syncMs).toBeGreaterThanOrEqual(5_000)
      })
    } finally {
      index.close()
    }
  })

  it("leaves index sync without a budget or back-off", async () => {
    const path = writeAgedSession("busy", "a", "b", "ls", 0)
    await indexSync({ dbPath: mockDbPath.value })
    grow(path)
    expect(await indexSync({ dbPath: mockDbPath.value })).toMatchObject({ sync: { parsed: 1, memoryFiles: 1, pending: 0 } })
  })

  it("says a transcript is behind without a warning, and warns only about ones never indexed", async () => {
    const path = writeAgedSession("busy", "deploy stalled on the lock", "b", "ls", 0)
    // Without the tool index, so the search syncs the memory store the way it does once an index exists.
    const proseSearch = async () => await searchSessions("deploy stalled", {}, null) as unknown as Response & { behind?: number }
    expect((await proseSearch()).behind).toBeUndefined()
    grow(path)
    const result = await proseSearch()
    expect(result.behind).toBe(1)
    expect(result.warnings).toBeUndefined()
    expect(result.results.map((entry) => entry.sessionId)).toEqual(["busy"])

    writeAgedSession("new", "e", "f", "ls", 1)
    withMemory((memory) => expect(syncTranscripts({ index: null, memory, backOff: true, budgetMs: -1 })).toMatchObject({ pending: 2, unindexed: 1 }))
  })
})
