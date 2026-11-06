// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createViewStore, projectOfCwd, STARTER_APP, VIEW_LIMITS, viewSummary, type ViewStore } from "../../views/store"

let root: string
let store: ViewStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cogpit-views-"))
  store = createViewStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const make = (id = "sales-funnel") => store.create({ id, title: "Sales funnel", project: "/work/app", sessionId: "s1" })

describe("view store", () => {
  it("starts a view with a starter app and no versions", async () => {
    const record = await make()
    expect(record).toMatchObject({ id: "sales-funnel", title: "Sales funnel", project: "/work/app", sessionId: "s1", versions: [] })
    expect(readFileSync(join(store.appDir("sales-funnel"), "App.tsx"), "utf8")).toBe(STARTER_APP)
    expect(await store.read("sales-funnel")).toEqual(record)
    expect(await store.readSources("sales-funnel")).toEqual([{ path: "App.tsx", text: STARTER_APP }])
  })

  it("refuses ids that are taken, reserved or malformed", async () => {
    await make()
    await expect(make()).rejects.toThrow(/already exists \(project \/work\/app\)/)
    await expect(make("shell")).rejects.toThrow(/reserved/)
    for (const id of ["Sales", "a--b", "-a", "../x", "a".repeat(49)]) {
      await expect(make(id)).rejects.toThrow(/not a view id/)
    }
  })

  it("stores each new build as the next version and skips a repeat", async () => {
    await make()
    const files = [{ path: "App.tsx", text: "x" }]
    const first = await store.addVersion("sales-funnel", { files, html: "<p>1</p>", sessionId: "s1" })
    const repeat = await store.addVersion("sales-funnel", { files, html: "<p>1</p>" })
    const second = await store.addVersion("sales-funnel", { files, html: "<p>2</p>", title: "Funnel" })
    expect([first.version.version, repeat.version.version, second.version.version]).toEqual([1, 1, 2])
    expect([first.created, repeat.created, second.created]).toEqual([true, false, true])
    expect(second.record.title).toBe("Funnel")
    expect(await store.readVersion("sales-funnel", 1)).toMatchObject({ html: "<p>1</p>", files })
    expect(await store.readVersion("sales-funnel", 3)).toBeNull()
    expect(await store.readVersion("nothing-here", 1)).toBeNull()
  })

  it("never gives two concurrent builds the same version", async () => {
    await make()
    const builds = await Promise.all([1, 2, 3, 4].map((n) => store.addVersion("sales-funnel", { files: [], html: `<p>${n}</p>` })))
    expect(builds.map((build) => build.version.version).sort()).toEqual([1, 2, 3, 4])
    expect((await store.read("sales-funnel"))!.versions).toHaveLength(4)
  })

  it("lists views newest first", async () => {
    await make("older")
    await make("newer")
    await store.addVersion("newer", { files: [], html: "x" })
    expect((await store.list()).map((record) => record.id)).toEqual(["newer", "older"])
    expect(await createViewStore(join(root, "missing")).list()).toEqual([])
  })

  it("reads nested source and data, skipping hidden files", async () => {
    await make()
    const app = store.appDir("sales-funnel")
    mkdirSync(join(app, "components"))
    writeFileSync(join(app, "components", "Bars.tsx"), "bars")
    writeFileSync(join(app, "data.json"), "{}")
    writeFileSync(join(app, ".DS_Store"), "")
    expect((await store.readSources("sales-funnel")).map((file) => file.path)).toEqual(["App.tsx", "components/Bars.tsx", "data.json"])
  })

  // Windows runners may not create symbolic links.
  it.skipIf(process.platform === "win32")("refuses links", async () => {
    await make()
    symlinkSync("/etc/hosts", join(store.appDir("sales-funnel"), "hosts.ts"))
    await expect(store.readSources("sales-funnel")).rejects.toThrow("hosts.ts: links are not allowed")
  })

  it("refuses other file types and files over the limits", async () => {
    await make()
    const app = store.appDir("sales-funnel")
    writeFileSync(join(app, "notes.md"), "")
    await expect(store.readSources("sales-funnel")).rejects.toThrow("notes.md: a view holds only")
    rmSync(join(app, "notes.md"))

    writeFileSync(join(app, "Big.tsx"), "x".repeat(VIEW_LIMITS.sourceBytes + 1))
    await expect(store.readSources("sales-funnel")).rejects.toThrow(/Big\.tsx is \d+ KB; the limit is 512 KB/)
    rmSync(join(app, "Big.tsx"))

    writeFileSync(join(app, "big.json"), "x".repeat(VIEW_LIMITS.sourceBytes + 1))
    await expect(store.readSources("sales-funnel")).resolves.toHaveLength(2)
  })

  it("renames, pins and deletes a view", async () => {
    await make()
    await store.addVersion("sales-funnel", { files: [], html: "x", sessionId: "s2" })
    const renamed = await store.update("sales-funnel", { title: " Funnel\n view ", pinned: true })
    expect(renamed).toMatchObject({ title: "Funnel view", pinned: true })
    expect(viewSummary(renamed)).toMatchObject({ id: "sales-funnel", latestVersion: 1, pinned: true, sessionId: "s1" })
    await expect(store.update("sales-funnel", { title: "   " })).rejects.toThrow(/title is 1 to 200/)
    await expect(store.update("nothing", { pinned: true })).rejects.toThrow(/No view "nothing"/)
    expect(await store.remove("sales-funnel")).toBe(true)
    expect(await store.read("sales-funnel")).toBeNull()
    expect(await store.readVersion("sales-funnel", 1)).toBeNull()
    expect(await store.list()).toEqual([])
    expect(await store.read("sales-funnel", { includeDeleted: true })).toMatchObject({ sessionId: "s1", deleted: true, versions: [] })
    expect(await store.remove("sales-funnel")).toBe(true)
    expect(await store.remove("never-made")).toBe(false)
    await expect(make()).rejects.toThrow(/was deleted and its id stays retired/)
    await expect(store.update("sales-funnel", { title: "Back" })).rejects.toThrow(/No view "sales-funnel"/)
  })

  it("files worktree folders under their parent checkout", () => {
    expect(projectOfCwd("/work/app/.claude/worktrees/feature")).toBe("/work/app")
    expect(projectOfCwd("/work/app")).toBe("/work/app")
  })
})

