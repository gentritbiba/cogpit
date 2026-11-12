// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { embeddingSettingsReport, saveEmbeddingSettings, testEmbeddingSettings } from "../../memory/embeddingSettings"
import { FAKE_DIMENSIONS, fakeEndpoint } from "./fakeEmbeddings"
import { makeSession, openMemoryStore, sourceFile } from "./helpers"

const URL_A = "https://embed.test/v1/embeddings"
const DEFAULTS = { dimensions: 256, minScore: 0.55 }
const INPUT = { url: URL_A, model: "fake", dimensions: FAKE_DIMENSIONS }

let dir: string
const configPath = () => join(dir, "config.json")
const savedSection = () => JSON.parse(readFileSync(configPath(), "utf8")).embeddings

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cogpit-embedding-settings-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("saveEmbeddingSettings", () => {
  it("writes the section owner-only and keeps the file's other sections", async () => {
    writeFileSync(configPath(), JSON.stringify({ other: { kept: true } }))

    expect(await saveEmbeddingSettings(dir, { ...INPUT, apiKey: "secret", queryPrefix: "Query: " })).toEqual({})

    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toMatchObject({
      other: { kept: true },
      embeddings: { url: URL_A, model: "fake", apiKey: "secret", dimensions: FAKE_DIMENSIONS, queryPrefix: "Query: " },
    })
    if (process.platform !== "win32") expect(statSync(configPath()).mode & 0o777).toBe(0o600)
  })

  it("keeps the saved key when none is typed and the endpoint stays on its origin", async () => {
    await saveEmbeddingSettings(dir, { ...INPUT, apiKey: "secret" })
    await saveEmbeddingSettings(dir, { ...INPUT, url: "https://embed.test/other/embeddings", model: "other" })

    expect(savedSection()).toMatchObject({ url: "https://embed.test/other/embeddings", model: "other", apiKey: "secret" })
  })

  it("drops the saved key when the endpoint moves to another origin", async () => {
    await saveEmbeddingSettings(dir, { ...INPUT, apiKey: "secret" })
    await saveEmbeddingSettings(dir, { ...INPUT, url: "https://elsewhere.test/v1/embeddings" })

    expect(savedSection().apiKey).toBeUndefined()
  })

  it("removes the key and the query prefix when they are emptied", async () => {
    await saveEmbeddingSettings(dir, { ...INPUT, apiKey: "secret", queryPrefix: "Query: " })
    await saveEmbeddingSettings(dir, { ...INPUT, apiKey: "", queryPrefix: "" })

    expect(savedSection()).toEqual({ url: URL_A, model: "fake", dimensions: FAKE_DIMENSIONS, minScore: 0.55, timeoutMs: 1500 })
  })

  it("refuses settings that cannot work and leaves the file alone", async () => {
    await saveEmbeddingSettings(dir, INPUT)
    const before = readFileSync(configPath(), "utf8")

    expect((await saveEmbeddingSettings(dir, { ...INPUT, url: "not a url" })).error).toContain("url must be an http(s) URL")
    expect((await saveEmbeddingSettings(dir, { ...INPUT, dimensions: 2 })).error).toContain("dimensions")
    expect(readFileSync(configPath(), "utf8")).toBe(before)
  })

  it("does not overwrite a file it cannot parse", async () => {
    writeFileSync(configPath(), "{not json")

    expect((await saveEmbeddingSettings(dir, INPUT)).error).toContain("not valid JSON")
    expect(readFileSync(configPath(), "utf8")).toBe("{not json")
  })

  it("turns embeddings off and keeps the rest of the file", async () => {
    writeFileSync(configPath(), JSON.stringify({ other: 1, embeddings: INPUT }))

    expect(await saveEmbeddingSettings(dir, null)).toEqual({})
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ other: 1 })
  })
})

describe("testEmbeddingSettings", () => {
  it("embeds one question with the typed key and the query prefix", async () => {
    const endpoint = fakeEndpoint()

    const result = await testEmbeddingSettings(dir, { ...INPUT, apiKey: "typed", queryPrefix: "Query: " }, endpoint.fetch)

    expect(result).toMatchObject({ ok: true })
    expect(endpoint.requests).toHaveLength(1)
    expect(endpoint.requests[0]).toMatchObject({ url: URL_A, model: "fake", headers: { authorization: "Bearer typed" } })
    expect(endpoint.requests[0].input[0]).toMatch(/^Query: /)
  })

  it("uses the saved key on the saved origin only", async () => {
    await saveEmbeddingSettings(dir, { ...INPUT, apiKey: "secret" })
    const endpoint = fakeEndpoint()

    await testEmbeddingSettings(dir, INPUT, endpoint.fetch)
    await testEmbeddingSettings(dir, { ...INPUT, url: "https://elsewhere.test/v1/embeddings" }, endpoint.fetch)

    expect(endpoint.requests[0].headers.authorization).toBe("Bearer secret")
    expect(endpoint.requests[1].headers.authorization).toBeUndefined()
  })

  it("says why the endpoint cannot be used, without the key", async () => {
    const refused = await testEmbeddingSettings(dir, { ...INPUT, apiKey: "secret" }, async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "bad key secret" }))
    expect(refused).toEqual({ ok: false, error: "the embedding endpoint answered 401: bad key [redacted]" })

    const tooSmall = await testEmbeddingSettings(dir, { ...INPUT, dimensions: 64 }, fakeEndpoint().fetch)
    expect(tooSmall).toEqual({ ok: false, error: `the endpoint returned ${FAKE_DIMENSIONS} dimensions; the configuration keeps 64` })

    expect(await testEmbeddingSettings(dir, { ...INPUT, model: " " }, fakeEndpoint().fetch)).toEqual({ ok: false, error: "embeddings: model is required" })
  })
})

describe("embeddingSettingsReport", () => {
  it("reports nothing configured for a missing file", async () => {
    expect(await embeddingSettingsReport(dir, null, {})).toEqual({ settings: null, progress: null, error: null, defaults: DEFAULTS })
  })

  it("shows the saved endpoint without its key, and how much text has a vector", async () => {
    await saveEmbeddingSettings(dir, { ...INPUT, apiKey: "secret", queryPrefix: "Query: " })
    const store = openMemoryStore()
    store.syncSession(sourceFile({ path: "/t/a.jsonl", sessionId: "a" }), makeSession([{ user: "ship the release", assistant: "The rollout is done." }]))
    const { hash } = store.db.prepare("SELECT text_hash AS hash FROM chunks ORDER BY id LIMIT 1").get() as { hash: string }
    store.db.prepare("INSERT INTO vectors (text_hash, fingerprint, vector, norm) VALUES (?, ?, ?, ?)").run(hash, `fake@${FAKE_DIMENSIONS}`, new Uint8Array(FAKE_DIMENSIONS), 1)

    const report = await embeddingSettingsReport(dir, { store: () => store, embeddingError: () => null }, {})

    expect(report).toEqual({
      settings: { url: URL_A, model: "fake", dimensions: FAKE_DIMENSIONS, queryPrefix: "Query: ", minScore: 0.55, hasApiKey: true },
      progress: { passages: 2, embedded: 1 },
      error: null,
      defaults: DEFAULTS,
    })
    expect(JSON.stringify(report)).not.toContain("secret")
  })

  it("passes on why embedding is stopped", async () => {
    await saveEmbeddingSettings(dir, INPUT)
    const report = await embeddingSettingsReport(dir, { store: () => null, embeddingError: () => "the embedding endpoint answered 503" }, {})

    expect(report).toMatchObject({ progress: null, error: "the embedding endpoint answered 503" })
  })

  it("says so when config.json cannot be used", async () => {
    writeFileSync(configPath(), "{not json")

    const report = await embeddingSettingsReport(dir, null, {})

    expect(report.settings).toBeNull()
    expect(report.error).toContain("not valid JSON")
  })
})
