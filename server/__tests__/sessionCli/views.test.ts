// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const accessLevel = vi.hoisted(() => vi.fn(async (_req: unknown, _sessionId: string): Promise<string | null> => null))
vi.mock("../../edition", async (original) => ({ ...(await original<typeof import("../../edition")>()), accessLevelOf: accessLevel }))

import { PERSONAL_EDITION } from "../../edition"
import { runSessionCli, type CliInvocation } from "../../sessionCli/commands"
import { viewCommand } from "../../sessionCli/views"
import { createViewStore, type ViewStore } from "../../views/store"

let root: string
let store: ViewStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-view-cli-"))
  store = createViewStore(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))

const run = async (argv: string[], overrides: Partial<CliInvocation> = {}) => {
  const output = await viewCommand({
    argv: ["view", ...argv],
    cwd: "/work/app/.claude/worktrees/feature",
    invocationId: "i1",
    scope: "local",
    admin: true,
    visible: PERSONAL_EDITION.access.visibilityFor({} as never),
    callerSessionId: "s-caller",
    ...overrides,
  }, argv, store)
  return { ...output, json: output.stdout ? JSON.parse(output.stdout) : null }
}

describe("cogpit-session view", () => {
  it("starts a view in its own folder, filed under the worktree's project", async () => {
    const { exitCode, json } = await run(["new", "sales-funnel", "--title", "Sales funnel"])
    expect(exitCode).toBe(0)
    expect(json).toMatchObject({ id: "sales-funnel", title: "Sales funnel", project: "/work/app", folder: store.appDir("sales-funnel"), latestVersion: null })
    expect(json.next).toContain("cogpit-session view build sales-funnel")
    expect((await store.read("sales-funnel"))!.sessionId).toBe("s-caller")
  })

  it("builds the starter into version 1 and prints the block for the reply", async () => {
    await run(["new", "sales-funnel"])
    const { exitCode, json } = await run(["build", "sales-funnel"])
    expect(exitCode).toBe(0)
    expect(json).toMatchObject({ id: "sales-funnel", built: true, version: 1, reply: "```cogpit-view\nsales-funnel@1\n```" })
    expect((await run(["build", "sales-funnel"])).json).toMatchObject({ version: 1, note: expect.stringContaining("Nothing changed") })
    expect((await store.readVersion("sales-funnel", 1))!.html).toContain("<title>Sales funnel</title>")
  })

  it("prints build problems with their location and stores nothing", async () => {
    await run(["new", "sales-funnel"])
    await writeFile(join(store.appDir("sales-funnel"), "App.tsx"), `import chart from "chart.js"\nexport default function App() {\n  return <p>{chart}</p>\n}`)
    const { exitCode, json } = await run(["build", "sales-funnel"])
    expect(exitCode).toBe(1)
    expect(json.errors).toEqual([expect.stringMatching(/^App\.tsx: Cannot import "chart\.js"/)])
    expect((await store.read("sales-funnel"))!.versions).toEqual([])
  })

  it("lists this project's views, or every project's", async () => {
    await run(["new", "here"])
    await run(["new", "elsewhere"], { cwd: "/work/other" })
    expect((await run(["list"])).json.map((view: { id: string }) => view.id)).toEqual(["here"])
    expect((await run(["list", "--all"])).json.map((view: { id: string }) => view.id).sort()).toEqual(["elsewhere", "here"])
    await run(["build", "here"])
    expect((await run(["show", "here"])).json).toMatchObject({ id: "here", latestVersion: 1, versions: [{ version: 1 }] })
  })

  it("explains bad ids, unknown views and missing commands", async () => {
    await expect(run(["new", "Sales Funnel"])).rejects.toThrow(/not a view id/)
    await expect(run(["build", "nothing"])).rejects.toThrow(/No view "nothing".*view new nothing/)
    await expect(run([])).rejects.toThrow(/needs a command/)
  })

  it("lets a member use views through the sessions they may work in", async () => {
    const levels: Record<string, "view" | "interact"> = { "s-caller": "interact", "s-watched": "view" }
    accessLevel.mockImplementation(async (_req: unknown, sessionId: string) => levels[sessionId] ?? null)
    const member = { admin: false, req: {} as never }
    await expect(run(["new", "x"], { admin: false })).rejects.toThrow(/needs COGPIT_SESSION_ID/)
    expect((await run(["new", "mine"], member)).exitCode).toBe(0)
    expect((await run(["build", "mine"], member)).json).toMatchObject({ built: true, version: 1 })
    await store.create({ id: "watched", title: "Watched", project: "/work/app", sessionId: "s-watched" })
    await store.create({ id: "hidden", title: "Hidden", project: "/work/app", sessionId: "s-other" })
    expect((await run(["list"], member)).json.map((view: { id: string }) => view.id).sort()).toEqual(["mine", "watched"])
    expect((await run(["show", "watched"], member)).json).toMatchObject({ id: "watched" })
    await expect(run(["build", "watched"], member)).rejects.toThrow(/No view "watched"/)
    await expect(run(["show", "hidden"], member)).rejects.toThrow(/No view "hidden"/)
    await expect(run(["new", "other"], { ...member, callerSessionId: "s-watched" })).rejects.toThrow(/needs COGPIT_SESSION_ID/)
  })

  it("is reachable from the cogpit-session CLI", async () => {
    const help = await runSessionCli({ argv: ["help"], cwd: "/", invocationId: "i", scope: "local", admin: true, visible: PERSONAL_EDITION.access.visibilityFor({} as never) })
    expect(help.stdout).toContain("view build ID")
    const unknown = await runSessionCli({ argv: ["view", "frobnicate"], cwd: "/", invocationId: "i", scope: "local", admin: true, visible: PERSONAL_EDITION.access.visibilityFor({} as never) })
    expect(unknown).toMatchObject({ exitCode: 1, stderr: expect.stringContaining(`Unknown view command "frobnicate"`) })
  })
})
