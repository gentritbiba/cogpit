// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  existing: new Set<string>(),
  hidden: new Set<string>(),
  everything: true,
  admin: true,
  denied: new Set<string>(),
}))

vi.mock("../../memory", () => ({ memoryIndexer: () => ({ counts: () => ({ pendingFiles: 3, pendingEmbeddings: 0 }) }) }))
vi.mock("../../memory/store", () => ({ transcriptExists: (path: string) => mocks.existing.has(path) }))
vi.mock("../../edition", async (original) => ({
  ...await original<typeof import("../../edition")>(),
  mayActHostWide: () => mocks.admin,
  visibilityFor: () => Object.assign(
    async (sessionId: string) => (mocks.hidden.has(sessionId) ? "hidden" : { annotate: async <T>(item: T) => item }),
    { everything: mocks.everything, nothing: false },
  ),
  itemVisibilityFor: () => async (sessionId: string | null) => sessionId !== null && !mocks.denied.has(sessionId),
  authorizeSession: async (_req: unknown, res: { statusCode: number; end(): void }, ref: { sessionId: string }) => {
    if (!mocks.denied.has(ref.sessionId)) return { sessionId: ref.sessionId }
    res.statusCode = 403
    res.end()
    return null
  },
}))

import type { LibraryResponse } from "../../../shared/library/types"
import { libraryStore, stopLibrary } from "../../library"
import type { Occurrence } from "../../library/store"
import { registerLibraryRoutes } from "../../routes/library"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

let home = ""

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cogpit-library-route-"))
  vi.stubEnv("COGPIT_LIBRARY_HOME", home)
  mocks.existing = new Set(["/t/a.jsonl", "/t/b.jsonl"])
  mocks.hidden = new Set()
  mocks.denied = new Set()
  mocks.everything = true
  mocks.admin = true
})

afterEach(async () => {
  await stopLibrary()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

async function call(url: string, method = "GET") {
  const handler = getRouteHandler(collectRoutes(registerLibraryRoutes), "/api/library")
  const { req, res, next } = createMockReqRes(method, url)
  await handler(req, res, next)
  return { status: res.statusCode, body: JSON.parse(res._getData() || "null"), next }
}

function seed(...occurrences: Array<Partial<Occurrence>>): void {
  libraryStore()!.record([], occurrences.map((overrides, index) => ({
    sessionId: "a",
    sourceFile: "/t/a.jsonl",
    cwd: "/work/app",
    project: "/work/app",
    kind: "link",
    target: `https://${index}.dev`,
    label: null,
    turn: index,
    turnId: `t${index}`,
    sharedAt: null,
    sharedMs: index,
    ...overrides,
  })), [{ session_id: "a", title: "Session A", cwd: "/work/app" }])
}

describe("GET /api/library", () => {
  it("lists a tab for a scope, with counts, sessions and the indexer's progress", async () => {
    seed({ target: "https://docs.dev" }, { kind: "file", target: "/tmp/report.pdf" }, { sessionId: "b", sourceFile: "/t/b.jsonl", target: "https://b.dev" })
    const { status, body } = await call("/?scope=session&session=a&tab=link")
    expect(status).toBe(200)
    const response = body as LibraryResponse
    expect(response).toMatchObject({ available: true, pendingFiles: 3, counts: { media: 0, link: 1, file: 1 }, next: null })
    expect(response.items.map((item) => item.target)).toEqual(["https://docs.dev"])
    expect(response.sessions).toEqual({ a: { title: "Session A", cwd: "/work/app" } })
  })

  it("refuses a malformed request", async () => {
    for (const query of ["scope=everywhere", "tab=audio", "scope=session", "scope=project", "limit=0", "limit=500"]) {
      expect((await call(`/?${query}`)).status, query).toBe(400)
    }
  })

  it("shows a member only sessions they may see, and no text whose transcript is gone", async () => {
    seed({ target: "https://a.dev" }, { sessionId: "b", sourceFile: "/t/b.jsonl", target: "https://b.dev" }, { sessionId: "c", sourceFile: "/t/gone.jsonl", target: "https://gone.dev" })
    expect(((await call("/?tab=link")).body as LibraryResponse).items.map((item) => item.target)).toEqual(["https://gone.dev", "https://b.dev", "https://a.dev"])
    mocks.everything = false
    mocks.admin = false
    mocks.hidden = new Set(["b"])
    expect(((await call("/?tab=link")).body as LibraryResponse).items.map((item) => item.target)).toEqual(["https://a.dev"])
  })

  it("passes other paths and methods on", async () => {
    expect((await call("/elsewhere")).next).toHaveBeenCalled()
    expect((await call("/", "POST")).next).toHaveBeenCalled()
  })
})

describe("DELETE /api/library/items/:id", () => {
  it("removes an item with the mentions the caller may change, and keeps it out", async () => {
    seed({ target: "https://same.dev" }, { sessionId: "b", sourceFile: "/t/b.jsonl", target: "https://same.dev" }, { sessionId: "c", target: "https://same.dev" })
    mocks.denied = new Set(["c"])
    const [newest] = ((await call("/?tab=link")).body as LibraryResponse).items
    expect(newest!.sessionId).toBe("c")
    const [first] = libraryStore()!.items(null, 10).filter((row) => row.session_id === "a")
    const { status, body } = await call(`/items/${first!.id}`, "DELETE")
    expect(status).toBe(200)
    expect(body).toEqual({ removed: 2 })
    expect(libraryStore()!.items(null, 10).map((row) => row.session_id)).toEqual(["c"])
    expect(await call(`/items/${first!.id}`, "DELETE")).toMatchObject({ status: 200, body: { removed: 0 } })
  })

  it("answers an unknown item as hidden and a session the caller may not change with a refusal", async () => {
    seed({ sessionId: "c" })
    expect((await call("/items/999", "DELETE")).status).toBe(404)
    mocks.denied = new Set(["c"])
    const [row] = libraryStore()!.items(null, 1)
    expect((await call(`/items/${row!.id}`, "DELETE")).status).toBe(403)
  })
})
