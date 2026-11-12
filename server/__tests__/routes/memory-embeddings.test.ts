// @vitest-environment node
import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  hostWide: true,
  report: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  hint: vi.fn(),
}))
vi.mock("../../edition", () => ({ markDecided: vi.fn(), mayActHostWide: () => mocks.hostWide }))
vi.mock("../../memory", () => ({ memoryIndexer: () => ({ hint: mocks.hint }) }))
vi.mock("../../memory/paths", () => ({ memoryDir: () => "/memory" }))
vi.mock("../../memory/embeddingSettings", () => ({ embeddingSettingsReport: mocks.report, saveEmbeddingSettings: mocks.save, testEmbeddingSettings: mocks.test }))

import type { Middleware, UseFn } from "../../http"
import { registerMemoryEmbeddingRoutes } from "../../routes/memory-embeddings"
import { asIncomingMessage, asServerResponse } from "../http-fixtures"

const REPORT = { settings: null, progress: null, error: null, defaults: { dimensions: 256, minScore: 0.55 } }
const SETTINGS = { url: "https://embed.test/v1/embeddings", model: "fake" }

function handler(): Middleware {
  let registered: Middleware | undefined
  const use: UseFn = (_path, middleware) => { registered = middleware }
  registerMemoryEmbeddingRoutes(use)
  return registered!
}

async function call(method: "GET" | "POST" | "DELETE", body?: unknown, url = "/") {
  const raw = { statusCode: 200, headersSent: false, setHeader: vi.fn(), body: "", end(chunk?: string) { this.body = chunk ?? "" } }
  const next = vi.fn()
  const req = asIncomingMessage(Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url, headers: {} as Record<string, string> }))
  await handler()(req, asServerResponse(raw), next)
  if (!next.mock.calls.length) await vi.waitFor(() => expect(raw.setHeader).toHaveBeenCalled())
  return { status: raw.statusCode, next, json: () => JSON.parse(raw.body) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hostWide = true
  mocks.report.mockResolvedValue(REPORT)
  mocks.save.mockResolvedValue({})
  mocks.test.mockResolvedValue({ ok: true, ms: 12 })
})

describe("/api/memory-embeddings", () => {
  it("reports the saved endpoint", async () => {
    const answer = await call("GET")

    expect(answer.status).toBe(200)
    expect(answer.json()).toEqual(REPORT)
    expect(mocks.report).toHaveBeenCalledWith("/memory", expect.anything())
  })

  it("is for host administrators only", async () => {
    mocks.hostWide = false

    expect((await call("GET")).status).toBe(403)
    expect((await call("POST", { action: "save", settings: SETTINGS })).status).toBe(403)
    expect((await call("POST", { action: "test", settings: SETTINGS })).status).toBe(403)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.test).not.toHaveBeenCalled()
  })

  it("saves, wakes the indexer and answers with the new report", async () => {
    const answer = await call("POST", { action: "save", settings: { ...SETTINGS, apiKey: "secret" } })

    expect(answer.status).toBe(200)
    expect(answer.json()).toEqual(REPORT)
    expect(mocks.save).toHaveBeenCalledWith("/memory", { ...SETTINGS, apiKey: "secret" })
    expect(mocks.hint).toHaveBeenCalledTimes(1)
  })

  it("turns embeddings off", async () => {
    expect((await call("POST", { action: "off" })).status).toBe(200)
    expect(mocks.save).toHaveBeenCalledWith("/memory", null)
  })

  it("answers 400 with the reason a save was refused, and does not wake the indexer", async () => {
    mocks.save.mockResolvedValue({ error: "embeddings: url must be an http(s) URL" })

    const answer = await call("POST", { action: "save", settings: SETTINGS })

    expect(answer.status).toBe(400)
    expect(answer.json()).toEqual({ error: "embeddings: url must be an http(s) URL" })
    expect(mocks.hint).not.toHaveBeenCalled()
  })

  it("tests an endpoint without saving it", async () => {
    const answer = await call("POST", { action: "test", settings: SETTINGS })

    expect(answer.json()).toEqual({ ok: true, ms: 12 })
    expect(mocks.test).toHaveBeenCalledWith("/memory", SETTINGS, expect.any(Function))
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it("refuses a body it does not understand", async () => {
    expect((await call("POST", { action: "wipe" })).status).toBe(400)
    expect((await call("POST", { action: "save" })).status).toBe(400)
    expect((await call("POST", { action: "save", settings: { url: 1, model: "fake" } })).status).toBe(400)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it("leaves other methods and paths to the next handler", async () => {
    expect((await call("DELETE")).next).toHaveBeenCalled()
    expect((await call("GET", undefined, "/else")).next).toHaveBeenCalled()
  })
})
