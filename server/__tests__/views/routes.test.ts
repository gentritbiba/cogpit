// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const access = vi.hoisted(() => ({
  /** Sessions the caller may see, with the level held; host-wide = may act on views no session made. */
  levels: new Map<string, "view" | "interact" | "own">(),
  hostWide: true,
  guestOf: null as string | null,
}))
vi.mock("../../edition", async (original) => {
  const real = await original<typeof import("../../edition")>()
  const levelOf = (sessionId: string) => access.levels.get(sessionId)
  const enough = (held: string, needed: string) => needed === "view" || held !== "view"
  return {
    ...real,
    markDecided: vi.fn(),
    itemVisibilityFor: () => async (sessionId: string | null, needed = "view") => {
      if (sessionId === null) return access.hostWide
      const held = levelOf(sessionId)
      return held !== undefined && enough(held, needed)
    },
    authorizeHostWide: (_req: unknown, res: ServerResponse) => {
      if (!access.hostWide) real.sendSessionHidden(res, null)
      return access.hostWide
    },
    authorizeSession: async (_req: unknown, res: ServerResponse, ref: { sessionId: string }, needed: string) => {
      const held = levelOf(ref.sessionId)
      if (held === undefined) { real.sendSessionHidden(res, null); return null }
      if (!enough(held, needed)) { real.sendSessionDenied(res, held as never, ref.sessionId); return null }
      return { sessionId: ref.sessionId }
    },
  }
})
vi.mock("../../share/requestGuest", () => ({ shareGuestSessionId: () => access.guestOf }))

import type { Middleware } from "../../http"
import { registerViewRoutes } from "../../routes/views"
import { createViewStore, type ViewStore } from "../../views/store"

let root: string
let store: ViewStore
let handler: Middleware

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cogpit-view-routes-"))
  store = createViewStore(root)
  registerViewRoutes((_path, route) => { handler = route }, () => store)
  access.levels = new Map([["s-mine", "own"], ["s-read", "view"]])
  access.hostWide = true
  access.guestOf = null
  await store.create({ id: "mine", title: "Mine", project: "/work/app", sessionId: "s-mine" })
  await store.addVersion("mine", { files: [{ path: "App.tsx", text: "x" }], html: "<p>1</p>", sessionId: "s-mine" })
  await store.create({ id: "shared-read", title: "Read only", project: "/work/app", sessionId: "s-read" })
  await store.create({ id: "secret", title: "Someone else's", project: "/work/other", sessionId: "s-other" })
  await store.create({ id: "loose", title: "No session", project: "/work/app" })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: {} }) as unknown as IncomingMessage
  return new Promise((done, fail) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader: vi.fn(),
      end: (text: string) => done({ status: res.statusCode, body: JSON.parse(text) }),
    }
    handler(req, res as unknown as ServerResponse, (error?: unknown) => (error ? fail(error) : done({ status: 0, body: null })))
  })
}

const ids = (body: unknown) => (body as { views: { id: string }[] }).views.map((view) => view.id).sort()

describe("view routes", () => {
  it("lists the views the caller may see, filtered by project (worktrees folded)", async () => {
    expect(ids((await call("GET", "/")).body)).toEqual(["loose", "mine", "shared-read"])
    expect(ids((await call("GET", `/?project=${encodeURIComponent("/work/app/.claude/worktrees/feature")}`)).body)).toEqual(["loose", "mine", "shared-read"])
    access.hostWide = false
    expect(ids((await call("GET", "/")).body)).toEqual(["mine", "shared-read"])
    const [mine] = ((await call("GET", "/?project=/work/app")).body as { views: Record<string, unknown>[] }).views.filter((view) => view.id === "mine")
    expect(mine).toEqual({ id: "mine", title: "Mine", project: "/work/app", sessionId: "s-mine", latestVersion: 1, updatedAt: expect.any(String), pinned: false })
  })

  it("serves a version's page and source only to callers who may see it", async () => {
    expect(await call("GET", "/mine/v/1")).toEqual({ status: 200, body: { id: "mine", title: "Mine", version: 1, latestVersion: 1, html: "<p>1</p>", files: [{ path: "App.tsx", text: "x" }] } })
    expect((await call("GET", "/mine/v/2")).status).toBe(404)
    await store.addVersion("secret", { files: [], html: "<p>secret</p>", sessionId: "s-other" })
    expect((await call("GET", "/secret/v/1")).status).toBe(404)
  })

  it("answers a missing view like a hidden one, so ids cannot be probed", async () => {
    await store.addVersion("secret", { files: [], html: "<p>secret</p>", sessionId: "s-other" })
    const hidden = await call("GET", "/secret/v/1")
    expect(hidden.status).toBe(404)
    expect(await call("GET", "/no-such-view/v/1")).toEqual(hidden)
    expect(await call("DELETE", "/no-such-view")).toEqual(hidden)
  })

  it("gives a share guest only the pages its shared session made", async () => {
    access.guestOf = "s-mine"
    expect((await call("GET", "/mine/v/1")).status).toBe(200)
    await store.addVersion("shared-read", { files: [], html: "<p>2</p>", sessionId: "s-read" })
    expect((await call("GET", "/shared-read/v/1")).status).toBe(404)
    expect(ids((await call("GET", "/")).body)).toEqual(["mine"])
    expect((await call("DELETE", "/mine")).status).toBe(404)
  })

  it("renames and pins a view the caller may work in", async () => {
    expect(await call("PATCH", "/mine", { title: "  Funnel  ", pinned: true })).toMatchObject({ status: 200, body: { id: "mine", title: "Funnel", pinned: true } })
    expect(await call("PATCH", "/mine", { title: "" })).toMatchObject({ status: 400 })
    expect((await call("PATCH", "/shared-read", { pinned: true })).status).toBe(403)
    expect((await call("PATCH", "/secret", { pinned: true })).status).toBe(404)
    expect((await store.read("mine"))!.pinned).toBe(true)
  })

  it("deletes a view with every version, and answers the same when asked again", async () => {
    expect(await call("DELETE", "/mine")).toEqual({ status: 200, body: { deleted: true } })
    expect(await call("DELETE", "/mine")).toEqual({ status: 200, body: { deleted: true } })
    expect(await store.read("mine")).toBeNull()
    expect((await call("GET", "/mine/v/1")).status).toBe(404)
    expect((await call("PATCH", "/mine", { pinned: true })).status).toBe(404)
    expect((await call("DELETE", "/secret")).status).toBe(404)
    expect(await store.read("secret")).not.toBeNull()
  })

  it("never lets a rename that raced a delete touch the view again", async () => {
    let release!: () => void
    let reading!: () => void
    const held = new Promise<void>((done) => { release = done })
    const authorized = new Promise<void>((done) => { reading = done })
    // The route reads the body only once it has authorized the rename.
    const body = Readable.from((async function* () { reading(); await held; yield Buffer.from(JSON.stringify({ title: "Renamed" })) })())
    const req = Object.assign(body, { method: "PATCH", url: "/mine", headers: {} }) as unknown as IncomingMessage
    const answered = new Promise<{ status: number; body: unknown }>((done) => {
      const res = { statusCode: 200, headersSent: false, setHeader: vi.fn(), end: (text: string) => done({ status: res.statusCode, body: JSON.parse(text) }) }
      handler(req, res as unknown as ServerResponse, () => done({ status: 0, body: null }))
    })
    await authorized
    expect(await call("DELETE", "/mine")).toEqual({ status: 200, body: { deleted: true } })
    await expect(store.create({ id: "mine", title: "Bob's", project: "/work/app", sessionId: "s-read" })).rejects.toThrow(/stays retired/)
    release()
    expect((await answered).status).toBe(404)
    expect(await store.read("mine", { includeDeleted: true })).toMatchObject({ deleted: true, sessionId: "s-mine", title: "Mine" })
  })

  it("leaves other methods and shapes to later routes", async () => {
    for (const [method, url] of [["POST", "/mine"], ["GET", "/mine"], ["GET", "/Bad-Id/v/1"], ["GET", "/mine/v/0"], ["PUT", "/mine"]] as const) {
      expect(await call(method, url), `${method} ${url}`).toEqual({ status: 0, body: null })
    }
  })
})
