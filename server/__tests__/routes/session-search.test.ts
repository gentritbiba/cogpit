// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createEmbeddingClient } from "../../../shared/memory/embeddings"
import type { MemoryStore } from "../../../shared/memory/store"
import { embedPending } from "../../../shared/memory/vectors"
import { FAKE_DIMENSIONS, fakeEndpoint } from "../memory/fakeEmbeddings"
import { makeSession, openMemoryStore, sourceFile } from "../memory/helpers"

const mocks = vi.hoisted(() => ({
  indexer: null as null | { store(): unknown; counts(): { pendingFiles: number; pendingEmbeddings: number }; embedder(): unknown },
  existing: new Set<string>(),
  hidden: new Set<string>(),
  everything: true,
  listed: [] as Array<{ filePath: string; fileName: string; dirName: string; sessionId: string; mtimeMs: number; size: number }>,
  admin: true,
  sessionFiles: new Map<string, string>(),
}))

vi.mock("../../memory", () => ({ memoryIndexer: () => mocks.indexer }))
vi.mock("../../memory/store", () => ({ transcriptExists: (path: string) => mocks.existing.has(path) }))
vi.mock("../../sessionCatalog", () => ({ sessionFileFor: (id: string) => mocks.sessionFiles.get(id) ?? null }))
vi.mock("../../agents", () => ({
  allStores: () => [],
  allTopLevelSessions: async () => mocks.listed,
  storeForPath: () => ({
    sessionAddress: async (path: string) => ({ dirName: "-work-project", fileName: path.split("/").pop() }),
  }),
}))
vi.mock("../../edition", async (original) => ({
  ...await original<typeof import("../../edition")>(),
  mayActHostWide: () => mocks.admin,
  visibilityFor: () => Object.assign(
    async (sessionId: string) => (mocks.hidden.has(sessionId) ? "hidden" : { annotate: async <T>(item: T) => item }),
    { everything: mocks.everything, nothing: false },
  ),
}))

import { registerSessionSearchRoutes, type SessionSearchResponse } from "../../routes/session-search"
import { shareRequestAllowed } from "../../share/allowlist"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

async function call(url: string, method = "GET") {
  const handler = getRouteHandler(collectRoutes(registerSessionSearchRoutes), "/api/session-search")
  const { req, res, next } = createMockReqRes(method, url)
  await handler(req, res, next)
  return { status: res.statusCode, body: JSON.parse(res._getData() || "null"), next }
}

async function search(query: string): Promise<SessionSearchResponse> {
  const { status, body } = await call(`/?${query}`)
  expect(status).toBe(200)
  return body as SessionSearchResponse
}

const ALPHA = sourceFile({ path: "/t/alpha.jsonl", sessionId: "alpha", agentKind: "claude" })
const ALPHA_AGENT = sourceFile({ path: "/t/alpha/subagents/agent-a1.jsonl", sessionId: "alpha", agentKind: "claude", isSubagent: true, parentSessionId: "alpha", agentId: "a1" })
const BETA = sourceFile({ path: "/t/beta.jsonl", sessionId: "beta", agentKind: "codex" })
const GONE = sourceFile({ path: "/t/gone.jsonl", sessionId: "gone", agentKind: "claude" })

function listed(...files: Array<{ path: string; sessionId: string }>) {
  return files.map((file) => ({ filePath: file.path, fileName: file.path.split("/").pop()!, dirName: "-work-project", sessionId: file.sessionId, mtimeMs: 1, size: 1 }))
}

/** A member of a team edition: sees only what the check lets through, never archived text. */
function asMember(hidden: string[] = []): void {
  mocks.everything = false
  mocks.admin = false
  mocks.hidden = new Set(hidden)
}

let store: MemoryStore

beforeEach(() => {
  store = openMemoryStore()
  store.syncSession(ALPHA, makeSession([
    { user: "fix the websocket reconnect", id: "u-1" },
    { user: "and the websocket backoff", assistant: "The websocket now backs off.", id: "u-2" },
  ]), { title: "Reconnect" })
  store.syncSession(ALPHA_AGENT, makeSession([{ assistant: "Found a websocket handshake race." }]))
  store.syncSession(BETA, makeSession([{ user: "websocket proxy settings" }], { cwd: "/work/other" }))
  store.syncSession(GONE, makeSession([{ user: "the old websocket server" }]))
  mocks.indexer = { store: () => store, counts: () => ({ pendingFiles: 3, pendingEmbeddings: 0 }), embedder: () => null }
  mocks.existing = new Set([ALPHA.path, ALPHA_AGENT.path, BETA.path])
  mocks.hidden = new Set()
  mocks.everything = true
  mocks.listed = listed(ALPHA, BETA)
  mocks.admin = true
  mocks.sessionFiles = new Map([["alpha", ALPHA.path]])
})

afterEach(() => {
  store.close()
})

describe("GET /api/session-search", () => {
  it("refuses a query it cannot run", async () => {
    for (const query of ["", "q=a", "q=%20x%20", "q=web&limit=0", "q=web&limit=51", "q=web&limit=two", "q=web&mode=fuzzy"]) {
      const { status, body } = await call(`/?${query}`)
      expect(status, query).toBe(400)
      expect(body.error, query).toEqual(expect.any(String))
    }
  })

  it("leaves other methods and paths to the next route", async () => {
    expect((await call("/?q=web", "POST")).next).toHaveBeenCalled()
    expect((await call("/alpha?q=web")).next).toHaveBeenCalled()
  })

  it("groups hits under the session the UI opens, a sub-agent's under its parent", async () => {
    const body = await search("q=websocket")
    expect(body.query).toBe("websocket")
    expect(body.indexing).toEqual({ pendingFiles: 3, pendingEmbeddings: 0 })
    expect(body.semantic.state).toBe("unavailable")
    expect(body.results.map((result) => result.sessionId).sort()).toEqual(["alpha", "beta", "gone"])

    const alpha = body.results.find((result) => result.sessionId === "alpha")!
    expect(alpha).toMatchObject({ dirName: "-work-project", fileName: "alpha.jsonl", title: "Reconnect", cwd: "/work/project", agentKind: "claude", archived: false })
    expect(alpha.hits.length).toBe(3)
    const fromAgent = alpha.hits.find((hit) => hit.agentId === "a1")
    const fromParent = alpha.hits.filter((hit) => hit.agentId === null)
    if (fromAgent) expect(fromAgent).toMatchObject({ openTurnId: null, openTurn: null })
    for (const hit of fromParent) {
      expect(hit.openTurn === 0 ? hit.openTurnId === "u-1" : hit.openTurn === 1 && hit.openTurnId === "u-2").toBe(true)
      expect(hit).not.toHaveProperty("text")
      expect(hit.snippet).toContain("websocket")
      expect(hit.match).toBe("keyword")
    }
  })

  it("returns no more sessions than asked for, best first", async () => {
    const body = await search("q=websocket&limit=1")
    expect(body.results).toHaveLength(1)
  })

  it("narrows to one project folder", async () => {
    const body = await search(`q=websocket&cwd=${encodeURIComponent("/work/other")}`)
    expect(body.results.map((result) => result.sessionId)).toEqual(["beta"])
  })

  it("shows an admin an archived session's stored text, without an address to open", async () => {
    const gone = (await search("q=websocket")).results.find((result) => result.sessionId === "gone")!
    expect(gone).toMatchObject({ dirName: null, fileName: null, archived: true })
    expect(gone.hits[0].text).toBe("the old websocket server")
  })

  it("keeps archived sessions out of an admin's answer in a narrower scope", async () => {
    mocks.everything = false
    const body = await search("q=websocket&scope=mine")
    expect(body.results.map((result) => result.sessionId).sort()).toEqual(["alpha", "beta"])
  })

  it("keeps archived sessions and sessions the caller may not see out of a member's answer", async () => {
    asMember(["beta"])
    const body = await search("q=websocket")
    expect(body.results.map((result) => result.sessionId)).toEqual(["alpha"])
  })

  it("searches only what a member may see, so higher-ranked hidden sessions never take its places", async () => {
    const others = Array.from({ length: 12 }, (_, index) => sourceFile({ path: `/t/other-${index}.jsonl`, sessionId: `other-${index}` }))
    for (const [index, other] of others.entries()) store.syncSession(other, makeSession([{ user: `websocket websocket websocket note${index}` }]))
    mocks.listed = listed(ALPHA, BETA, ...others)
    for (const other of others) mocks.existing.add(other.path)
    asMember(["alpha", ...others.map((other) => other.sessionId)])

    const body = await search("q=websocket&limit=1")
    expect(body.results.map((result) => result.sessionId)).toEqual(["beta"])
  })

  it.each([["before", "after"], ["after", "before"]])("keeps a member's hit when a hidden fork with the same text was indexed %s it", async (forkAt) => {
    const mine = sourceFile({ path: "/t/mine.jsonl", sessionId: "mine" })
    const fork = sourceFile({ path: "/t/fork.jsonl", sessionId: "fork" })
    const text = makeSession([{ user: "the flaky turbine gauge" }])
    for (const file of forkAt === "before" ? [fork, mine] : [mine, fork]) store.syncSession(file, text)
    mocks.listed = listed(mine, fork)
    mocks.existing.add(mine.path).add(fork.path)
    asMember(["fork"])

    const body = await search("q=turbine")
    expect(body.results.map((result) => result.sessionId)).toEqual(["mine"])
  })

  it("keeps an archived sub-agent hit out of a member's answer while its session stays", async () => {
    asMember()
    mocks.existing.delete(ALPHA_AGENT.path)
    const alpha = (await search("q=handshake")).results
    expect(alpha).toEqual([])
  })

  it("answers with no results while the store is missing or empty, and says why semantic search is off", async () => {
    mocks.indexer = null
    expect(await search("q=websocket")).toEqual({
      query: "websocket",
      semantic: { state: "unavailable", reason: expect.any(String) },
      indexing: { pendingFiles: 0, pendingEmbeddings: 0 },
      results: [],
    })
    expect((await search("q=websocket&mode=keyword")).semantic).toEqual({ state: "off" })

    mocks.indexer = { store: () => openMemoryStore(), counts: () => ({ pendingFiles: 0, pendingEmbeddings: 0 }), embedder: () => null }
    expect((await search("q=websocket")).results).toEqual([])
  })

  it("answers a search by meaning with keywords while no endpoint is configured", async () => {
    const body = await search("q=websocket&mode=semantic")
    expect(body.semantic).toEqual({ state: "unavailable", reason: "no embedding endpoint is configured" })
    expect(body.results.length).toBeGreaterThan(0)
  })

  it("finds a session by meaning when the indexer has an embedding client", async () => {
    const car = sourceFile({ path: "/t/car.jsonl", sessionId: "car", agentKind: "claude" })
    store.syncSession(car, makeSession([{ user: "the engine stalls at idle" }]))
    mocks.existing.add(car.path)
    const client = createEmbeddingClient({ url: "http://embed.test/v1/embeddings", model: "fake", dimensions: FAKE_DIMENSIONS, minScore: 0.5 }, fakeEndpoint().fetch)
    await embedPending(store, client)
    mocks.indexer = { ...mocks.indexer!, embedder: () => ({ client }) }

    const body = await search("q=automobile")
    expect(body.semantic).toEqual({ state: "ready" })
    expect(body.results.map((result) => result.sessionId)).toEqual(["car"])
    expect(body.results[0].hits[0]).toMatchObject({ match: "semantic", snippet: expect.stringContaining("engine") })
  })

  it("is not reachable by a share guest", () => {
    expect(shareRequestAllowed("GET", "/api/session-search?q=websocket", { sessionId: "alpha", dirName: "-work-project", fileName: "alpha.jsonl" })).toBe(false)
  })
})
