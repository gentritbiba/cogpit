// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CHUNKER_VERSION } from "../../../shared/memory/chunker"
import { withTx } from "../../../shared/memory/database"
import { MemoryStoreUnavailableError, SCHEMA_VERSION } from "../../../shared/memory/schema"
import { MemoryStore } from "../../../shared/memory/store"
import { makeSession, openMemoryStore, sourceFile } from "./helpers"

const stores: MemoryStore[] = []
const dirs: string[] = []

function open(path?: string): MemoryStore {
  const store = openMemoryStore(path)
  stores.push(store)
  return store
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "cogpit-memory-store-"))
  dirs.push(dir)
  return join(dir, "memory.db")
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function texts(store: MemoryStore): string[] {
  return (store.db.prepare("SELECT text FROM chunks ORDER BY turn, block, part").all() as Array<{ text: string }>).map((row) => row.text)
}

describe("MemoryStore schema", () => {
  it("migrates once and reopens without changes", () => {
    const path = tempDb()
    open(path).close()
    stores.pop()
    const store = open(path)
    expect((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect((store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal")
  })

  it("upgrades a store written before sync durations were recorded", () => {
    const path = tempDb()
    const old = open(path)
    old.syncSession(sourceFile(), makeSession([{ user: "kept across the upgrade" }]), { now: 7 })
    old.db.exec("ALTER TABLE source_files DROP COLUMN sync_ms; PRAGMA user_version = 2")
    old.close()
    stores.pop()
    expect(open(path).syncedFiles().get(sourceFile().path)).toMatchObject({ syncedAtMs: 7, syncMs: null })
  })

  it("refuses a store written by a newer schema", () => {
    const path = tempDb()
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    expect(() => MemoryStore.open(db)).toThrow(MemoryStoreUnavailableError)
    db.close()
  })

  it("rolls a failed transaction back", () => {
    const store = open()
    expect(() => withTx(store.db, () => {
      store.db.exec("INSERT INTO sessions (session_id, instance_id, agent_kind, cwd) VALUES ('x', 'default', 'acp', '/')")
      throw new Error("boom")
    })).toThrow("boom")
    expect(store.status().sessions).toBe(0)
  })
})

describe("MemoryStore.syncSession", () => {
  it("stores chunks, a session snapshot and the file state", () => {
    const store = open()
    const file = sourceFile()
    const result = store.syncSession(file, makeSession([{ user: "Set up the deploy", assistant: "Done with the release workflow." }]), { now: 5, elapsedMs: 4_000 })
    expect(result).toEqual({ added: 2, updated: 0, removed: 0, kept: 0, superseded: false })
    const state = store.syncedFiles().get(file.path)
    expect(state).toEqual({ mtimeMs: 1_000, size: 100, chunkerVersion: CHUNKER_VERSION, inlineAgents: [], syncedAtMs: 5, syncMs: expect.any(Number) })
    expect(state!.syncMs).toBeGreaterThanOrEqual(4_000)
    expect(state!.syncMs).toBeLessThan(5_000)
    expect(store.db.prepare("SELECT session_id, cwd, title, source_file FROM sessions").all()).toEqual([
      { session_id: "session-1", cwd: "/work/project", title: "Set up the deploy", source_file: file.path },
    ].map((row) => expect.objectContaining(row)))
    const status = store.status()
    expect(status).toMatchObject({ sourceFiles: 1, sessions: 1, chunks: 2, chunksByKind: { user: 1, assistant: 1 }, lastSyncAt: new Date(5).toISOString() })
  })

  it("replaces what a re-parse changed and keeps what it did not", () => {
    const store = open()
    const file = sourceFile()
    store.syncSession(file, makeSession([{ user: "first", assistant: "reply one" }, { user: "second", assistant: "reply two" }]))
    const ids = store.db.prepare("SELECT id FROM chunks ORDER BY id").all()
    const result = store.syncSession(file, makeSession([{ user: "first", assistant: "reply one, edited" }]))
    expect(result).toEqual({ added: 0, updated: 1, removed: 2, kept: 1, superseded: false })
    expect(texts(store)).toEqual(["first", "reply one, edited"])
    expect(store.db.prepare("SELECT id FROM chunks ORDER BY id").all()).toEqual(ids.slice(0, 2))
  })

  it("updates metadata without rewriting unchanged text", () => {
    const store = open()
    const file = sourceFile()
    store.syncSession(file, makeSession([{ user: "same words", id: "random-a" }]))
    const result = store.syncSession(file, makeSession([{ user: "same words", id: "random-b" }]))
    expect(result).toEqual({ added: 0, updated: 0, removed: 0, kept: 1, superseded: false })
    expect(store.db.prepare("SELECT turn_id FROM chunks").get()).toEqual(expect.objectContaining({ turn_id: "random-b" }))
  })

  it("keeps a session's title once known and fills a subagent's session row from its parent later", () => {
    const store = open()
    const parent = sourceFile()
    const child = sourceFile({ path: "/transcripts/session-1/subagents/agent-a1.jsonl", isSubagent: true, parentSessionId: "session-1", agentId: "a1" })
    store.syncSession(child, makeSession([{ user: "subtask" }]))
    expect(store.db.prepare("SELECT title FROM sessions").get()).toEqual(expect.objectContaining({ title: null }))
    store.syncSession(parent, makeSession([{ user: "Typed prompt" }]), { title: "Chosen title" })
    store.syncSession(parent, makeSession([{ user: "Typed prompt" }]), { title: null })
    expect(store.db.prepare("SELECT title FROM sessions").get()).toEqual(expect.objectContaining({ title: "Chosen title" }))
    expect(store.db.prepare("SELECT agent_id FROM chunks WHERE text = 'subtask'").get()).toEqual(expect.objectContaining({ agent_id: "a1" }))
  })

  it("lets no writer replace a newer state of a file with an older parse", () => {
    const path = tempDb()
    const server = open(path)
    const cli = open(path)
    server.syncSession(sourceFile({ mtimeMs: 2, size: 200 }), makeSession([{ user: "first" }, { user: "added later" }]))
    const late = cli.syncSession(sourceFile({ mtimeMs: 1, size: 100 }), makeSession([{ user: "first" }]))
    expect(late).toEqual({ added: 0, updated: 0, removed: 0, kept: 0, superseded: true })
    expect(texts(server)).toEqual(["first", "added later"])
    expect(server.syncedFiles().get("/transcripts/session-1.jsonl")).toMatchObject({ mtimeMs: 2, size: 200 })
    expect(cli.syncSession(sourceFile({ mtimeMs: 2, size: 200 }), makeSession([{ user: "first" }, { user: "added later" }])).superseded).toBe(false)
  })

  it("never drops chunks because a transcript disappeared", () => {
    const store = open()
    store.syncSession(sourceFile(), makeSession([{ user: "remember this" }]))
    expect(store.status({ fileExists: () => false })).toMatchObject({ chunks: 1, archivedFiles: 1 })
    expect(store.status({ fileExists: () => true }).archivedFiles).toBe(0)
  })
})

describe("MemoryStore.planSync", () => {
  it("returns new and changed files, newest first", () => {
    const store = open()
    const synced = sourceFile({ path: "/t/a.jsonl" })
    store.syncSession(synced, makeSession([{ user: "a" }]))
    const plan = store.planSync([
      synced,
      sourceFile({ path: "/t/a.jsonl", size: 101 }),
      sourceFile({ path: "/t/b.jsonl", mtimeMs: 5 }),
      sourceFile({ path: "/t/c.jsonl", mtimeMs: 9 }),
    ])
    expect(plan.map((file) => [file.path, file.size])).toEqual([["/t/a.jsonl", 101], ["/t/c.jsonl", 100], ["/t/b.jsonl", 100]])
  })

  it("re-syncs a parent once a subagent it reported inline gains its own transcript", () => {
    const store = open()
    const parent = sourceFile()
    const report = {
      agentId: "b2", agentName: null, subagentType: null, type: "assistant" as const, content: null, toolCalls: [], thinking: [], text: ["inline report"],
      timestamp: "2026-11-01T10:00:00.000Z", tokenUsage: null, model: null, isBackground: false,
    }
    const parentSession = makeSession([{ user: "go", blocks: [{ kind: "sub_agent", messages: [report] }] }])
    store.syncSession(parent, parentSession)
    expect(store.syncedFiles().get(parent.path)?.inlineAgents).toEqual(["b2"])
    expect(store.planSync([parent])).toEqual([])

    const child = sourceFile({ path: "/transcripts/session-1/subagents/agent-b2.jsonl", isSubagent: true, parentSessionId: "session-1", agentId: "b2" })
    expect(store.planSync([parent, child]).map((file) => file.path)).toEqual([parent.path, child.path])
    store.syncSession(parent, parentSession, { hasSubagentTranscript: (agentId) => agentId === "b2" })
    expect(texts(store)).toEqual(["go"])
    expect(store.planSync([parent, child]).map((file) => file.path)).toEqual([child.path])
  })

  it("re-chunks files an older chunker version wrote, and leaves a newer one's alone", () => {
    const store = open()
    const file = sourceFile()
    store.syncSession(file, makeSession([{ user: "a" }]))
    store.db.exec("UPDATE source_files SET chunker_version = 0")
    expect(store.planSync([file])).toEqual([file])
    store.db.exec(`UPDATE source_files SET chunker_version = ${CHUNKER_VERSION + 1}`)
    expect(store.planSync([file])).toEqual([])
    expect(store.syncSession(file, makeSession([{ user: "b" }])).superseded).toBe(true)
  })
})
