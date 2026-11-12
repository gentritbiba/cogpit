// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { createEmbeddingClient } from "../../../shared/memory/embeddings"
import { MemoryStoreUnavailableError } from "../../../shared/memory/schema"
import type { MemoryStore } from "../../../shared/memory/store"
import type { SourceFile } from "../../../shared/memory/types"
import type { ParsedSession } from "../../../shared/session/types"
import { embedderFor } from "../../memory"
import { createMemoryIndexer, type Embedder, type MemoryIndexer, type MemoryIndexerOptions } from "../../memory/indexer"
import { FAKE_DIMENSIONS, fakeEndpoint } from "./fakeEmbeddings"
import { makeSession, openMemoryStore, sourceFile } from "./helpers"

const EMBEDDINGS_CONFIG = JSON.stringify({ embeddings: { url: "http://embed.test/v1/embeddings", model: "fake", dimensions: FAKE_DIMENSIONS } })

const ROOT = sourceFile({ path: "/t/root.jsonl", sessionId: "root", mtimeMs: 2_000 })
const AGENT = sourceFile({ path: "/t/root/subagents/agent-a1.jsonl", sessionId: "root", isSubagent: true, parentSessionId: "root", agentId: "a1", mtimeMs: 1_000 })

interface Harness {
  indexer: MemoryIndexer
  store: MemoryStore
  files: SourceFile[]
  sessions: Map<string, ParsedSession>
  parsed: string[]
  warn: ReturnType<typeof vi.fn>
}

const running: MemoryIndexer[] = []

function harness(overrides: Partial<MemoryIndexerOptions> = {}): Harness {
  const store = openMemoryStore()
  const files = [ROOT, AGENT]
  const sessions = new Map<string, ParsedSession>([
    [ROOT.path, makeSession([{ user: "fix the flaky websocket reconnect", assistant: "The reconnect loop now backs off." }])],
    [AGENT.path, makeSession([{ user: "investigate websocket", assistant: "Found the race in the socket handshake." }])],
  ])
  const parsed: string[] = []
  const warn = vi.fn()
  const indexer = createMemoryIndexer({
    openStore: () => store,
    listFiles: async () => files.map((file) => ({ ...file })),
    parse: async (file) => {
      parsed.push(file.path)
      return sessions.get(file.path) ?? null
    },
    title: async (file) => (file.path === ROOT.path ? "Websocket reconnect" : null),
    readEmbeddingConfig: async () => ({ text: null, stamp: "" }),
    createEmbedder: () => null,
    warn,
    pause: async () => {},
    startDelayMs: 0,
    backstopMs: 60_000,
    ...overrides,
  })
  running.push(indexer)
  return { indexer, store, files, sessions, parsed, warn }
}

async function firstPass(h: Harness): Promise<void> {
  h.indexer.start()
  await vi.advanceTimersByTimeAsync(0)
  await h.indexer.settled()
}

function chunkCount(store: MemoryStore, path: string): number {
  return (store.db.prepare("SELECT COUNT(*) AS n FROM chunks c JOIN source_files f ON f.id = c.file_id WHERE f.path = ?").get(path) as { n: number }).n
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((indexer) => indexer.stop()))
  vi.useRealTimers()
})

describe("memory indexer", () => {
  it("reconciles every listed transcript, sub-agents included, with the title the session list shows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = harness()
    await firstPass(h)

    expect(h.parsed).toEqual([ROOT.path, AGENT.path])
    expect(chunkCount(h.store, ROOT.path)).toBe(2)
    expect(chunkCount(h.store, AGENT.path)).toBe(2)
    expect(h.store.db.prepare("SELECT title FROM sessions WHERE session_id = 'root'").get()).toEqual({ title: "Websocket reconnect" })
    expect(h.indexer.counts()).toEqual({ pendingFiles: 0, pendingEmbeddings: 0 })
  })

  it("syncs a new transcript on the backstop pass even when nothing hinted at it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = harness()
    await firstPass(h)
    const late = sourceFile({ path: "/t/late.jsonl", sessionId: "late", mtimeMs: 3_000 })
    h.files.push(late)
    h.sessions.set(late.path, makeSession([{ user: "a session written while the feed was quiet" }]))

    await vi.advanceTimersByTimeAsync(60_000)
    await h.indexer.settled()

    expect(chunkCount(h.store, late.path)).toBe(1)
  })

  it("re-reads a transcript that is being written at most a tenth of the time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const slowParse: MemoryIndexerOptions["parse"] = async (file) => {
      h.parsed.push(file.path)
      if (file.path === ROOT.path) vi.setSystemTime(Date.now() + 1_000)
      return h.sessions.get(file.path) ?? null
    }
    const h = harness({ parse: (file) => slowParse(file), backstopMs: 1_000 })
    await firstPass(h)
    h.parsed.length = 0

    h.files[0] = { ...ROOT, mtimeMs: 2_500, size: 200 }
    await vi.advanceTimersByTimeAsync(5_000)
    await h.indexer.settled()
    expect(h.parsed).toEqual([])
    expect(h.indexer.counts().pendingFiles).toBe(1)

    await vi.advanceTimersByTimeAsync(7_000)
    await h.indexer.settled()
    expect(h.parsed).toEqual([ROOT.path])
    expect(h.indexer.counts().pendingFiles).toBe(0)
  })

  it("waits for a heavy transcript to go quiet before reading it again, but not forever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = harness({
      parse: async (file) => {
        h.parsed.push(file.path)
        if (file.path === ROOT.path) vi.setSystemTime(Date.now() + 300)
        return h.sessions.get(file.path) ?? null
      },
      backstopMs: 1_000,
    })
    await firstPass(h)
    h.parsed.length = 0
    const write = () => { h.files[0] = { ...ROOT, mtimeMs: Date.now(), size: h.files[0].size + 1 } }

    write()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.parsed).toEqual([])
    await vi.advanceTimersByTimeAsync(31_000)
    expect(h.parsed).toEqual([ROOT.path])

    h.parsed.length = 0
    for (let second = 0; second < 590; second += 10) {
      write()
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(h.parsed).toEqual([])
    write()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.parsed).toEqual([ROOT.path])
  })

  it("backs off a transcript that fails to parse, longer each time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = harness({
      parse: async (file) => {
        h.parsed.push(file.path)
        if (file.path === ROOT.path) throw new Error("truncated record")
        return h.sessions.get(file.path) ?? null
      },
      backstopMs: 1_000,
    })
    await firstPass(h)
    const attempts = () => h.parsed.filter((path) => path === ROOT.path).length
    expect(attempts()).toBe(1)

    await vi.advanceTimersByTimeAsync(9_000)
    expect(attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(18_000)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(attempts()).toBe(3)
  })

  it("runs sooner after a hint, waiting for the pass in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = harness()
    await firstPass(h)
    const late = sourceFile({ path: "/t/hinted.jsonl", sessionId: "hinted", mtimeMs: 3_000 })
    h.files.push(late)
    h.sessions.set(late.path, makeSession([{ user: "written just now" }]))

    h.indexer.hint()
    await vi.advanceTimersByTimeAsync(2_000)
    await h.indexer.settled()

    expect(chunkCount(h.store, late.path)).toBe(1)
  })

  it("turns itself off quietly when the store cannot work here", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const listFiles = vi.fn(async () => [])
    const h = harness({ openStore: () => { throw new MemoryStoreUnavailableError("no FTS5") }, listFiles })
    await firstPass(h)
    h.indexer.hint()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.indexer.store()).toBeNull()
    expect(listFiles).not.toHaveBeenCalled()
    expect(h.warn).not.toHaveBeenCalled()
  })

  it("says once why the store could not be opened for any other reason", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = harness({ openStore: () => { throw new Error("EACCES") } })
    await firstPass(h)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.indexer.store()).toBeNull()
    expect(h.warn).toHaveBeenCalledTimes(1)
  })

  it("stops cleanly: waits for the pass in flight, closes the store and runs no more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness({
      parse: async (file) => {
        h.parsed.push(file.path)
        await gate
        return h.sessions.get(file.path) ?? null
      },
    })
    const close = vi.spyOn(h.store, "close")
    h.indexer.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.parsed).toEqual([ROOT.path])

    const stopped = h.indexer.stop()
    release()
    await stopped

    expect(h.parsed).toEqual([ROOT.path])
    expect(close).toHaveBeenCalledTimes(1)
    expect(h.indexer.store()).toBeNull()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.parsed).toEqual([ROOT.path])
  })
})

describe("memory indexer embeddings", () => {
  function embedderWith(results: Array<{ embedded: number; remaining: number; error?: string }>): Embedder & { calls: number } {
    const embedder = {
      client: createEmbeddingClient({ url: "http://embed.test/v1/embeddings", model: "fake", dimensions: FAKE_DIMENSIONS }, fakeEndpoint().fetch),
      calls: 0,
      async embedPending() {
        const result = results[Math.min(embedder.calls, results.length - 1)]
        embedder.calls++
        return result
      },
    }
    return embedder
  }

  it("embeds after a pass once a config file appears, and re-reads it when it changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let config = { text: null as string | null, stamp: "" }
    const embedder = embedderWith([{ embedded: 4, remaining: 0 }])
    const createEmbedder = vi.fn((text: string | null) => (text ? embedder : null))
    const h = harness({ readEmbeddingConfig: async () => config, createEmbedder, backstopMs: 1_000 })
    await firstPass(h)
    expect(embedder.calls).toBe(0)

    config = { text: "{\"embeddings\":{}}", stamp: "1" }
    await vi.advanceTimersByTimeAsync(1_000)
    await h.indexer.settled()
    expect(embedder.calls).toBe(1)
    expect(h.indexer.embedder()).toBe(embedder)
    expect(createEmbedder).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(createEmbedder).toHaveBeenCalledTimes(2)
  })

  it("retries a down endpoint with back-off and says so once per outage", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const down = { embedded: 0, remaining: 7, error: "connect ECONNREFUSED 127.0.0.1:8790" }
    const embedder = embedderWith([down, down, down, { embedded: 7, remaining: 0 }, down])
    const h = harness({ readEmbeddingConfig: async () => ({ text: "{}", stamp: "1" }), createEmbedder: () => embedder, backstopMs: 600_000 })
    await firstPass(h)
    expect(embedder.calls).toBe(1)
    expect(h.indexer.counts().pendingEmbeddings).toBe(7)

    await vi.advanceTimersByTimeAsync(29_000)
    expect(embedder.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(embedder.calls).toBe(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(embedder.calls).toBe(3)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(embedder.calls).toBe(4)
    expect(h.indexer.counts().pendingEmbeddings).toBe(0)
    expect(h.warn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(embedder.calls).toBe(5)
    expect(h.warn).toHaveBeenCalledTimes(2)
  })

  it("keeps embedding soon while a pass leaves work and the endpoint answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const embedder = embedderWith([{ embedded: 32, remaining: 50 }, { embedded: 50, remaining: 0 }])
    const h = harness({ readEmbeddingConfig: async () => ({ text: "{}", stamp: "1" }), createEmbedder: () => embedder, backstopMs: 600_000 })
    await firstPass(h)
    await vi.advanceTimersByTimeAsync(1_000)
    await h.indexer.settled()

    expect(embedder.calls).toBe(2)
    expect(h.indexer.counts().pendingEmbeddings).toBe(0)
  })
})

describe("memory indexer with an OpenAI-compatible endpoint", () => {
  function vectorCount(store: MemoryStore): number {
    return (store.db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as { n: number }).n
  }

  it("embeds every synced chunk through the endpoint config.json names", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const endpoint = fakeEndpoint()
    const h = harness({ readEmbeddingConfig: async () => ({ text: EMBEDDINGS_CONFIG, stamp: "1" }), createEmbedder: (text) => embedderFor(text, endpoint.fetch, {}) })
    await firstPass(h)

    expect(endpoint.requests.length).toBeGreaterThan(0)
    expect(endpoint.requests[0].url).toBe("http://embed.test/v1/embeddings")
    expect(vectorCount(h.store)).toBe(4)
    expect(h.indexer.counts().pendingEmbeddings).toBe(0)
    expect(h.indexer.embedder()?.client.fingerprint).toBe(`fake@${FAKE_DIMENSIONS}`)
  })

  it("keeps the text searchable and says once that a down endpoint is down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const endpoint = fakeEndpoint(() => 503)
    const h = harness({ readEmbeddingConfig: async () => ({ text: EMBEDDINGS_CONFIG, stamp: "1" }), createEmbedder: (text) => embedderFor(text, endpoint.fetch, {}) })
    h.indexer.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(endpoint.requests.length).toBeGreaterThan(3)

    expect(chunkCount(h.store, ROOT.path)).toBe(2)
    expect(vectorCount(h.store)).toBe(0)
    expect(h.indexer.counts().pendingEmbeddings).toBe(4)
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(String(h.warn.mock.calls[0][0])).toContain("unavailable")
    expect(h.indexer.embeddingError()).toContain("503")
  })

  it("reports no embedding error while the endpoint answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = harness({ readEmbeddingConfig: async () => ({ text: EMBEDDINGS_CONFIG, stamp: "1" }), createEmbedder: (text) => embedderFor(text, fakeEndpoint().fetch, {}) })
    await firstPass(h)

    expect(h.indexer.embeddingError()).toBeNull()
  })

  it("leaves texts the endpoint refuses for the backstop pass instead of resending them every second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const endpoint = fakeEndpoint(() => 400)
    const h = harness({ readEmbeddingConfig: async () => ({ text: EMBEDDINGS_CONFIG, stamp: "1" }), createEmbedder: (text) => embedderFor(text, endpoint.fetch, {}), backstopMs: 60_000 })
    await firstPass(h)
    const firstPassRequests = endpoint.requests.length
    expect(h.indexer.counts().pendingEmbeddings).toBe(4)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(endpoint.requests.length).toBe(firstPassRequests)
    expect(h.warn).not.toHaveBeenCalled()
  })

  it("says once that config.json is not usable, and indexes text without embeddings", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = harness({ readEmbeddingConfig: async () => ({ text: "{not json", stamp: "1" }), createEmbedder: (text) => embedderFor(text, fakeEndpoint().fetch, {}), backstopMs: 1_000 })
    await firstPass(h)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(chunkCount(h.store, ROOT.path)).toBe(2)
    expect(h.indexer.embedder()).toBeNull()
    expect(h.indexer.embeddingError()).toContain("not valid JSON")
    expect(h.warn).toHaveBeenCalledTimes(1)
  })
})
