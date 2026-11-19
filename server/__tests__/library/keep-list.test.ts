// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { keepPending, KEEP_LIMITS } from "../../library/keep"
import { listLibrary, type LibraryQuery } from "../../library/list"
import { LibraryStore, type Occurrence } from "../../library/store"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cogpit-library-"))
  const store = LibraryStore.open(new DatabaseSync(":memory:"))
  cleanups.push(() => store.close(), () => rmSync(root, { recursive: true, force: true }))
  return { root, store, filesDir: join(root, "files") }
}

const NOW = Date.parse("2026-11-19T12:00:00.000Z")

function occurrence(overrides: Partial<Occurrence>): Occurrence {
  return {
    sessionId: "s1",
    sourceFile: "/t/s1.jsonl",
    cwd: "/work/app",
    project: "/work/app",
    kind: "link",
    target: "https://a.dev",
    label: null,
    turn: 0,
    turnId: "t0",
    sharedAt: new Date(NOW).toISOString(),
    sharedMs: NOW,
    ...overrides,
  }
}

function writeShared(root: string, name: string, content: string, mtimeMs = NOW - 1_000): string {
  const path = join(root, name)
  writeFileSync(path, content)
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  return path
}

const everyone = async () => true

function query(overrides: Partial<LibraryQuery>): LibraryQuery {
  return { scope: "all", tab: "media", limit: 60, ...overrides }
}

describe("keepPending", () => {
  it("copies shared files by content and keeps each version a reused path showed", async () => {
    const { root, store, filesDir } = setup()
    const shot = writeShared(root, "shot.png", "first")
    store.record([], [occurrence({ kind: "image", target: shot, turnId: "t1", sharedMs: NOW - 500 })], [])
    expect(await keepPending(store, filesDir)).toBe(1)

    writeShared(root, "shot.png", "second", NOW + 10_000)
    store.record([], [occurrence({ kind: "image", target: shot, turnId: "t2", sharedMs: NOW + 20_000 })], [])
    expect(await keepPending(store, filesDir)).toBe(1)

    const items = (await listLibrary(store, query({}), { filesDir, visible: everyone })).items
    expect(items.map((item) => readFileSync(item.keptPath!, "utf8"))).toEqual(["second", "first"])
    expect(items.every((item) => item.keepState === "kept" && item.present)).toBe(true)
  })

  it("does not copy a file rewritten after it was shared, a missing one, or one over its limit", async () => {
    const { root, store, filesDir } = setup()
    const changed = writeShared(root, "changed.png", "new", NOW + 10 * 60_000)
    const big = writeShared(root, "big.pdf", "x".repeat(64))
    store.record([], [
      occurrence({ kind: "image", target: changed }),
      occurrence({ kind: "video", target: join(root, "gone.webm") }),
      occurrence({ kind: "file", target: big }),
    ], [])
    await keepPending(store, filesDir, { limits: { ...KEEP_LIMITS, file: 32 } })
    const states = Object.fromEntries(store.items(null, 10).map((row) => [row.target.slice(root.length + 1), row.keep_state]))
    expect(states).toEqual({ "changed.png": "changed", "gone.webm": "missing", "big.pdf": "too-large" })
  })

  it("clears copies an earlier process left half made", async () => {
    const { root, store, filesDir } = setup()
    mkdirSync(filesDir, { recursive: true })
    writeFileSync(join(filesDir, ".incoming-stale"), "partial")
    store.record([], [occurrence({ kind: "image", target: writeShared(root, "a.png", "a") })], [])
    await keepPending(store, filesDir)
    expect(readdirSync(filesDir).filter((name) => name.startsWith("."))).toEqual([])
  })

  it("stores identical content once", async () => {
    const { root, store, filesDir } = setup()
    store.record([], [
      occurrence({ kind: "image", target: writeShared(root, "a.png", "same") }),
      occurrence({ kind: "image", target: writeShared(root, "b.png", "same") }),
    ], [])
    await keepPending(store, filesDir)
    expect(readdirSync(filesDir)).toHaveLength(1)
    expect(store.keptBytes()).toBe(4)
    expect((await listLibrary(store, query({}), { filesDir, visible: everyone })).items).toHaveLength(1)
  })

  it("drops the oldest copies to make room under the quota, never a newer one for an older", async () => {
    const { root, store, filesDir } = setup()
    const limits = { ...KEEP_LIMITS, quota: 10 }
    store.record([], [occurrence({ kind: "image", target: writeShared(root, "old.png", "aaaaaa", NOW - 60_000), sharedMs: NOW - 50_000, turnId: "a" })], [])
    await keepPending(store, filesDir, { limits })
    store.record([], [occurrence({ kind: "image", target: writeShared(root, "new.png", "bbbbbb"), turnId: "b" })], [])
    await keepPending(store, filesDir, { limits })
    store.record([], [occurrence({ kind: "image", target: writeShared(root, "older.png", "cccccc", NOW - 90_000), sharedMs: NOW - 80_000, turnId: "c" })], [])
    await keepPending(store, filesDir, { limits })

    const states = Object.fromEntries(store.items(null, 10).map((row) => [row.target.slice(root.length + 1), row.keep_state]))
    expect(states).toEqual({ "new.png": "kept", "old.png": "evicted", "older.png": "evicted" })
    expect(readdirSync(filesDir)).toHaveLength(1)
  })
})

describe("listLibrary", () => {
  it("counts every tab, folds repeats into the newest mention and pages by cursor", async () => {
    const { store, filesDir } = setup()
    store.record([], [
      occurrence({ target: "https://a.dev", turnId: "1", sharedMs: NOW - 3 }),
      occurrence({ target: "https://b.dev", turnId: "2", sharedMs: NOW - 2 }),
      occurrence({ target: "https://a.dev", turnId: "3", sharedMs: NOW - 1, label: "A docs", sessionId: "s2", sourceFile: "/t/s2.jsonl" }),
      occurrence({ kind: "file", target: "/tmp/r.pdf", turnId: "4" }),
      occurrence({ kind: "view", target: "chart", turnId: "5" }),
    ], [{ session_id: "s2", title: "Second", cwd: "/work/app" }])

    const first = await listLibrary(store, query({ tab: "link", limit: 1 }), { filesDir, visible: everyone })
    expect(first.counts).toEqual({ media: 0, link: 2, file: 1 })
    expect(first.viewIds).toEqual(["chart"])
    expect(first.items.map((item) => [item.target, item.label, item.mentions, item.sessionId])).toEqual([["https://a.dev", "A docs", 2, "s2"]])
    expect(first.sessions).toEqual({ s2: { title: "Second", cwd: "/work/app" } })
    const second = await listLibrary(store, query({ tab: "link", limit: 1, before: first.next! }), { filesDir, visible: everyone })
    expect(second.items.map((item) => item.target)).toEqual(["https://b.dev"])
    expect(second.next).toBeNull()
    expect((await listLibrary(store, query({ tab: undefined }), { filesDir, visible: everyone })).items).toEqual([])
  })

  it("lists a session's or a project's items, and only from sessions the caller may see", async () => {
    const { store, filesDir } = setup()
    store.record([], [
      occurrence({ target: "https://mine.dev" }),
      occurrence({ target: "https://other-project.dev", sessionId: "s2", sourceFile: "/t/s2.jsonl", project: "/work/other", turnId: "x" }),
      occurrence({ target: "https://hidden.dev", sessionId: "s3", sourceFile: "/t/s3.jsonl", turnId: "y" }),
    ], [])
    const visible = async (sessionId: string) => sessionId !== "s3"
    const list = async (overrides: Partial<LibraryQuery>) => (await listLibrary(store, query({ tab: "link", ...overrides }), { filesDir, visible })).items.map((item) => item.target)
    expect(await list({ scope: "session", sessionId: "s2" })).toEqual(["https://other-project.dev"])
    expect(await list({ scope: "project", project: "/work/app/.claude/worktrees/fix" })).toEqual(["https://mine.dev"])
    expect((await list({})).sort()).toEqual(["https://mine.dev", "https://other-project.dev"])
    expect(await list({ text: "OTHER" })).toEqual(["https://other-project.dev"])
  })

  it("leaves out an image or video with no copy and no file left, but not a gone document", async () => {
    const { root, store, filesDir } = setup()
    store.record([], [
      occurrence({ kind: "image", target: join(root, "gone.png"), turnId: "1" }),
      occurrence({ kind: "image", target: writeShared(root, "here.png", "x"), turnId: "2" }),
      occurrence({ kind: "file", target: join(root, "gone.pdf"), turnId: "3" }),
    ], [])
    const listing = await listLibrary(store, query({}), { filesDir, visible: everyone })
    expect(listing.counts).toEqual({ media: 1, link: 0, file: 1 })
    expect(listing.items.map((item) => item.target)).toEqual([join(root, "here.png")])
    const files = await listLibrary(store, query({ tab: "file" }), { filesDir, visible: everyone })
    expect(files.items.map((item) => [item.target, item.present])).toEqual([[join(root, "gone.pdf"), false]])
  })

  it("leaves out an image whose path now holds a later file than the reply showed", async () => {
    const { root, store, filesDir } = setup()
    const shot = writeShared(root, "shot.png", "later", NOW + 10 * 60_000)
    store.record([], [occurrence({ kind: "image", target: shot })], [])
    await keepPending(store, filesDir)
    expect(store.items(null, 1)[0]!.keep_state).toBe("changed")
    expect((await listLibrary(store, query({}), { filesDir, visible: everyone })).counts.media).toBe(0)
  })

  it("removes an item for good, deleting a copy nothing lists any more", async () => {
    const { root, store, filesDir } = setup()
    store.record([], [occurrence({ kind: "image", target: writeShared(root, "a.png", "a") })], [])
    await keepPending(store, filesDir)
    const [row] = store.items(null, 1)
    const orphans = store.remove(store.duplicates(row!).map((duplicate) => duplicate.id))
    expect(orphans).toHaveLength(1)
    store.record([], [occurrence({ kind: "image", target: join(root, "a.png") })], [])
    expect(store.items(null, 10)).toEqual([])
  })
})
