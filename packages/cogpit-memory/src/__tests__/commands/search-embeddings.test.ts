import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installDirsMock, mockDbPath, mockDirs, writeSession } from "../fixtures"

installDirsMock()

const { searchSessions } = await import("../../commands/search")
const { indexConfig, indexStats, indexSync } = await import("../../commands/index-cmd")

/** Same-topic words share an axis, so the fake model matches by meaning. */
const TOPICS: Record<string, number> = { car: 0, automobile: 0, engine: 0, pizza: 1, lunch: 1, food: 1 }

function vectorFor(text: string): number[] {
  const vector = new Array<number>(16).fill(0)
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (TOPICS[word] !== undefined) vector[TOPICS[word]!] += 1
    else vector[8 + (word.length % 8)] += 0.05
  }
  return vector
}

let server: ReturnType<typeof Bun.serve>
let requests: Array<{ input: string[]; authorization: string | null }> = []
let tmpDir: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { input: string[] }
      requests.push({ input: body.input, authorization: request.headers.get("authorization") })
      return Response.json({ data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) })) })
    },
  })
})

afterAll(() => {
  server.stop(true)
})

type Response = {
  totalHits: number
  returnedHits: number
  semantic: string
  semanticReason?: string
  results: Array<{ sessionId: string; hits: Array<Record<string, unknown>> }>
}

describe("search and index with an embedding endpoint", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-embed-"))
    mockDirs.PROJECTS_DIR = join(tmpDir, "projects")
    mockDirs.CODEX_SESSIONS_DIR = join(tmpDir, "codex")
    mockDirs.COPILOT_SESSIONS_DIR = join(tmpDir, "copilot")
    mockDirs.ACP_PROJECTS_DIR = join(tmpDir, "acp")
    mockDbPath.value = join(tmpDir, "index", "search-index.db")
    process.env.COGPIT_MEMORY_DIR = join(tmpDir, "memory")
    requests = []
    const project = join(mockDirs.PROJECTS_DIR, "-work")
    mkdirSync(project, { recursive: true })
    writeSession(project, "cars.jsonl", { sessionId: "cars", userMessage: "the car will not start", assistantMessage: "Replace the engine battery." })
    writeSession(project, "food.jsonl", { sessionId: "food", userMessage: "lunch plans", assistantMessage: "Pizza." })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes the configuration owner-only, shows it with the key masked, and turns it off", async () => {
    const url = `http://127.0.0.1:${server.port}/v1/embeddings`
    expect(await indexConfig({ url, model: "fake", dimensions: 16, apiKey: "secret", queryPrefix: "Q: " })).toMatchObject({
      embeddings: { url, model: "fake", dimensions: 16, apiKey: "(set)", queryPrefix: "Q: " },
    })
    const path = join(process.env.COGPIT_MEMORY_DIR!, "config.json")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, "utf8")).embeddings.apiKey).toBe("secret")
    expect(await indexConfig({})).toMatchObject({ embeddings: { state: "configured", config: { apiKey: "(set)", minScore: 0.55 } } })
    expect(await indexConfig({ dimensions: 2 })).toEqual({ error: expect.stringContaining("dimensions") })
    expect(await indexConfig({}, true)).toMatchObject({ embeddings: null })
    expect(await indexConfig({})).toMatchObject({ embeddings: { state: "off" } })
  })

  it("embeds pending passages in index sync and finds them by meaning", async () => {
    await indexConfig({ url: `http://127.0.0.1:${server.port}/v1/embeddings`, model: "fake", dimensions: 16, apiKey: "secret" })
    const synced = await indexSync({ dbPath: mockDbPath.value })
    expect(synced).toMatchObject({ embeddings: { fingerprint: "fake@16", embedded: 4, remaining: 0 }, memory: { embeddings: { embedded: 4, pending: 0 } } })
    expect(requests[0]!.authorization).toBe("Bearer secret")
    expect(await indexStats(mockDbPath.value)).toMatchObject({ memory: { embeddings: { pending: 0 }, embeddingConfig: { state: "configured" } } })

    const response = await searchSessions("automobile trouble", { mode: "semantic" }) as unknown as Response
    expect(response.semantic).toBe("ready")
    expect(response.results.map((result) => result.sessionId)).toEqual(["cars"])
    expect(response.results[0]!.hits[0]).toMatchObject({ match: "semantic", matchCount: 0 })
    expect(response.results[0]!.hits[0]!.similarity).toBeGreaterThan(0.5)
    expect(response.totalHits).toBe(response.returnedHits)
    expect(response.totalHits).toBeGreaterThan(0)

    const hybrid = await searchSessions("pizza", {}) as unknown as Response
    expect(hybrid.results[0]!.hits[0]).toMatchObject({ match: "both" })
  })

  it("searches by keyword and says why when the endpoint is down", async () => {
    await indexConfig({ url: "http://127.0.0.1:9/v1/embeddings", model: "fake", dimensions: 16, timeoutMs: 300 })
    const synced = await indexSync({ dbPath: mockDbPath.value })
    expect(synced).toMatchObject({ embeddings: { embedded: 0, remaining: 4, error: expect.stringContaining("could not be reached") } })
    const response = await searchSessions("pizza", {}) as unknown as Response
    expect(response.semantic).toBe("unavailable")
    expect(response.semanticReason).toContain("could not be reached")
    expect(response.results[0]!.hits[0]).toMatchObject({ match: "keyword" })
  })

  it("leaves the endpoint alone in keyword mode", async () => {
    await indexConfig({ url: `http://127.0.0.1:${server.port}/v1/embeddings`, model: "fake", dimensions: 16 })
    const response = await searchSessions("pizza", { mode: "keyword" }) as unknown as Response
    expect(response.semantic).toBe("off")
    expect(requests).toEqual([])
  })
})
