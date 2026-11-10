// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import {
  cosine,
  createEmbeddingClient,
  DEFAULT_MIN_SCORE,
  embeddingFingerprint,
  parseEmbeddingConfig,
  quantize,
  type EmbeddingConfig,
} from "../../../shared/memory/embeddings"
import { searchProse } from "../../../shared/memory/search"
import type { MemoryStore } from "../../../shared/memory/store"
import { embedPending } from "../../../shared/memory/vectors"
import { FAKE_DIMENSIONS, fakeEndpoint } from "./fakeEmbeddings"
import { makeSession, openMemoryStore, sourceFile } from "./helpers"

const stores: MemoryStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function open(): MemoryStore {
  const store = openMemoryStore()
  stores.push(store)
  return store
}

const CONFIG: EmbeddingConfig = { url: "http://embed.test/v1/embeddings", model: "fake", dimensions: FAKE_DIMENSIONS, minScore: 0.5, timeoutMs: 200 }

describe("parseEmbeddingConfig", () => {
  it("reads the embeddings section with defaults, and lets the environment override it", () => {
    expect(parseEmbeddingConfig(JSON.stringify({ embeddings: { url: "http://x/v1/embeddings", model: "m" } }), {})).toEqual({
      config: { url: "http://x/v1/embeddings", model: "m", dimensions: 256, minScore: DEFAULT_MIN_SCORE, timeoutMs: 1500 },
    })
    expect(parseEmbeddingConfig(JSON.stringify({ embeddings: { url: "http://x/v1/embeddings", model: "m" } }), {
      COGPIT_EMBED_DIMENSIONS: "64",
      COGPIT_EMBED_QUERY_PREFIX: "Query: ",
    }).config).toMatchObject({ dimensions: 64, queryPrefix: "Query: " })
    expect(parseEmbeddingConfig(null, { COGPIT_EMBED_URL: "http://env/v1/embeddings", COGPIT_EMBED_MODEL: "e" }).config?.model).toBe("e")
  })

  it("is off without a file or section, and reports a broken one", () => {
    expect(parseEmbeddingConfig(null, {})).toEqual({ config: null })
    expect(parseEmbeddingConfig("{}", {})).toEqual({ config: null })
    expect(parseEmbeddingConfig("{nope", {}).error).toContain("not valid JSON")
    expect(parseEmbeddingConfig(JSON.stringify({ embeddings: { url: "ftp://x", model: "m" } }), {}).error).toContain("url")
    expect(parseEmbeddingConfig(JSON.stringify({ embeddings: { url: "http://x", model: "m", dimensions: 3 } }), {}).error).toContain("dimensions")
    expect(parseEmbeddingConfig(JSON.stringify({ embeddings: { url: "http://x", model: "m", minScore: 2 } }), {}).error).toContain("minScore")
  })

  it("fingerprints a vector by model and dimensions", () => {
    expect(embeddingFingerprint(CONFIG)).toBe(`fake@${FAKE_DIMENSIONS}`)
  })
})

describe("quantize", () => {
  it("keeps the first dimensions, scales to int8 and preserves the cosine closely", () => {
    const a = quantize([0.3, -0.2, 0.9, 0.1, 99], 4)
    const b = quantize([0.31, -0.18, 0.88, 0.12, -99], 4)
    expect(a.values).toEqual(new Int8Array([42, -28, 127, 14]))
    const exact = (0.3 * 0.31 + 0.2 * 0.18 + 0.9 * 0.88 + 0.1 * 0.12) / (Math.hypot(0.3, 0.2, 0.9, 0.1) * Math.hypot(0.31, 0.18, 0.88, 0.12))
    expect(cosine(a, b.values, b.norm)).toBeCloseTo(exact, 2)
  })

  it("refuses a vector shorter than the configured dimensions, and scores a zero vector 0", () => {
    expect(() => quantize([1, 2], 4)).toThrow("returned 2 dimensions")
    expect(cosine(quantize([0, 0], 2), new Int8Array([1, 1]), Math.SQRT2)).toBe(0)
  })
})

describe("createEmbeddingClient", () => {
  it("sends the model, the key and the query prefix, and maps answers by index", async () => {
    const endpoint = fakeEndpoint()
    const client = createEmbeddingClient({ ...CONFIG, apiKey: "secret", queryPrefix: "Q: " }, endpoint.fetch)
    const [car, lunch] = await client.embedDocuments(["car", "lunch"])
    expect(car!.values[0]).toBe(127)
    expect(lunch!.values[1]).toBe(127)
    await client.embedQuery("automobile")
    expect(endpoint.requests.map((request) => request.input)).toEqual([["car", "lunch"], ["Q: automobile"]])
    expect(endpoint.requests[0]!.headers.authorization).toBe("Bearer secret")
    expect(endpoint.requests[0]!.model).toBe("fake")
  })

  it("retries server errors for documents but not refusals", async () => {
    const flaky = fakeEndpoint((_, attempt) => (attempt === 1 ? 503 : undefined))
    await createEmbeddingClient(CONFIG, flaky.fetch).embedDocuments(["car"])
    expect(flaky.requests).toHaveLength(2)

    const refusing = fakeEndpoint(() => 400)
    await expect(createEmbeddingClient(CONFIG, refusing.fetch).embedDocuments(["car"])).rejects.toThrow("answered 400")
    expect(refusing.requests).toHaveLength(1)
  })

  it("gives up on a query after its timeout", async () => {
    const hanging = fakeEndpoint(() => "hang")
    await expect(createEmbeddingClient({ ...CONFIG, timeoutMs: 50 }, hanging.fetch).embedQuery("car")).rejects.toThrow("within 50 ms")
  })
})

describe("embedPending", () => {
  function seed(store: MemoryStore): void {
    store.syncSession(sourceFile(), makeSession([
      { user: "the car will not start", assistant: "Check the engine." },
      { user: "lunch plans", assistant: "Pizza." },
    ]))
    // A fork repeats a prompt: its text is embedded once.
    store.syncSession(sourceFile({ path: "/t/fork.jsonl", sessionId: "fork" }), makeSession([{ user: "the car will not start" }]))
  }

  it("embeds each distinct text once and reuses it for identical chunks", async () => {
    const store = open()
    seed(store)
    const endpoint = fakeEndpoint()
    const result = await embedPending(store, createEmbeddingClient(CONFIG, endpoint.fetch), { batchSize: 2 })
    expect(result).toMatchObject({ fingerprint: `fake@${FAKE_DIMENSIONS}`, embedded: 4, reused: 1, failed: 0, remaining: 0 })
    expect(endpoint.requests.map((request) => request.input.length)).toEqual([2, 2])
    expect(store.status({ fingerprint: result.fingerprint }).embeddings).toEqual({ fingerprint: result.fingerprint, embedded: 5, pending: 0 })
    expect((await embedPending(store, createEmbeddingClient(CONFIG, endpoint.fetch))).embedded).toBe(0)
  })

  it("stops when the endpoint is down and resumes later", async () => {
    const store = open()
    seed(store)
    const down = await embedPending(store, createEmbeddingClient(CONFIG, fakeEndpoint(() => 503).fetch))
    expect(down.embedded).toBe(0)
    expect(down.error).toContain("503")
    expect(down.remaining).toBe(5)
    expect(await embedPending(store, createEmbeddingClient(CONFIG, fakeEndpoint().fetch))).toMatchObject({ embedded: 4, remaining: 0 })
  })

  it("keeps the texts an endpoint accepts when it refuses one", async () => {
    const store = open()
    seed(store)
    const picky = fakeEndpoint((input) => (input.some((text) => text.includes("Pizza")) ? 400 : undefined))
    expect(await embedPending(store, createEmbeddingClient(CONFIG, picky.fetch), { batchSize: 10 })).toMatchObject({ embedded: 3, failed: 1, remaining: 1 })
  })

  it("treats another model or size as pending and drops its vectors once current", async () => {
    const store = open()
    seed(store)
    await embedPending(store, createEmbeddingClient(CONFIG, fakeEndpoint().fetch))
    const other = createEmbeddingClient({ ...CONFIG, dimensions: 8 }, fakeEndpoint().fetch)
    expect(store.status({ fingerprint: other.fingerprint }).embeddings?.pending).toBe(5)
    await embedPending(store, other)
    expect(store.db.prepare("SELECT DISTINCT fingerprint FROM vectors").all()).toEqual([expect.objectContaining({ fingerprint: "fake@8" })])
  })

  it("respects its time budget and drops vectors no chunk uses any more", async () => {
    const store = open()
    seed(store)
    const client = createEmbeddingClient(CONFIG, fakeEndpoint().fetch)
    expect(await embedPending(store, client, { budgetMs: -1 })).toMatchObject({ embedded: 0, remaining: 5 })
    await embedPending(store, client)
    store.syncSession(sourceFile(), makeSession([{ user: "only this now" }]), { now: 2 })
    store.syncSession(sourceFile({ path: "/t/fork.jsonl", sessionId: "fork" }), makeSession([]))
    await embedPending(store, client)
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual(expect.objectContaining({ n: 1 }))
  })
})

describe("searchProse with embeddings", () => {
  async function seeded(): Promise<{ store: MemoryStore; endpoint: ReturnType<typeof fakeEndpoint> }> {
    const store = open()
    store.syncSession(sourceFile(), makeSession([
      { user: "the car will not start", assistant: "The engine needs a new battery." },
      { user: "lunch plans for friday", assistant: "Pizza at noon." },
      { user: "how do we deploy", assistant: "The release goes out through the pipeline." },
    ]))
    const endpoint = fakeEndpoint()
    await embedPending(store, createEmbeddingClient(CONFIG, endpoint.fetch))
    return { store, endpoint }
  }

  it("finds passages by meaning alone, with no keyword shared", async () => {
    const { store, endpoint } = await seeded()
    const result = await searchProse(store, "automobile trouble", { embeddings: createEmbeddingClient(CONFIG, endpoint.fetch) })
    expect(result.semantic).toEqual({ state: "ready" })
    expect(result.hits.map((hit) => hit.text).sort()).toEqual(["The engine needs a new battery.", "the car will not start"])
    const car = result.hits.find((hit) => hit.text === "the car will not start")!
    expect(car).toMatchObject({ match: "semantic", matchCount: 0, snippet: "the car will not start" })
    expect(car.similarity).toBeGreaterThan(0.9)
    expect(result.hits.map((hit) => hit.ranks.semantic)).toEqual([1, 2])
    expect(result.keywordHits).toBe(0)
  })

  it("fuses keyword and meaning, ranking a passage found both ways first", async () => {
    const { store, endpoint } = await seeded()
    const result = await searchProse(store, "release automobile", { embeddings: createEmbeddingClient(CONFIG, endpoint.fetch) })
    expect(result.hits[0]).toMatchObject({ text: "The release goes out through the pipeline.", match: "both", matchCount: 1 })
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score)
  })

  it("leaves out vectors below the score floor", async () => {
    const { store, endpoint } = await seeded()
    const result = await searchProse(store, "automobile food", { embeddings: createEmbeddingClient({ ...CONFIG, minScore: 0.9 }, endpoint.fetch) })
    expect(result.hits).toEqual([])
  })

  it("answers with keywords and says why when the endpoint fails or is not configured", async () => {
    const { store } = await seeded()
    const failing = await searchProse(store, "pizza", { embeddings: createEmbeddingClient(CONFIG, fakeEndpoint(() => "hang").fetch), mode: "semantic" })
    expect(failing.semantic).toEqual({ state: "unavailable", reason: "the embedding endpoint did not answer within 200 ms" })
    expect(failing.hits.map((hit) => [hit.text, hit.match])).toEqual([["Pizza at noon.", "keyword"]])
    expect((await searchProse(store, "pizza")).semantic).toEqual({ state: "unavailable", reason: "no embedding endpoint is configured" })
  })

  it("skips the endpoint in keyword mode and keywords in semantic mode", async () => {
    const { store, endpoint } = await seeded()
    const client = createEmbeddingClient(CONFIG, endpoint.fetch)
    const before = endpoint.requests.length
    const keyword = await searchProse(store, "pizza", { embeddings: client, mode: "keyword" })
    expect(keyword.semantic).toEqual({ state: "off" })
    expect(endpoint.requests.length).toBe(before)
    const semantic = await searchProse(store, "pizza", { embeddings: client, mode: "semantic" })
    expect(semantic.hits.map((hit) => hit.match)).toEqual(["semantic", "semantic"])
  })

  it("centres a long semantic-only snippet on a shared word", async () => {
    const store = open()
    const long = `${"filler words here. ".repeat(30)}the car broke ${"more filler text. ".repeat(30)}`
    store.syncSession(sourceFile(), makeSession([{ assistant: long }]))
    const client = createEmbeddingClient({ ...CONFIG, minScore: 0.1 }, fakeEndpoint().fetch)
    await embedPending(store, client)
    const result = await searchProse(store, "Car", { embeddings: client, mode: "semantic" })
    expect(result.hits[0]!.snippet).toMatch(/^\.\.\..*car broke.*\.\.\.$/)
    expect(result.hits[0]!.snippet.length).toBeLessThan(260)
  })
})
