// @vitest-environment node
import { readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createBundle, fetchBundle, type TransferBundle } from "../../workspaceTransfer/bundle"
import {
  exportWorkspace,
  importWorkspace,
  knownCommits,
  removeWorkspace,
  sanitizeTaskName,
} from "../../workspaceTransfer/deviceStore"
import { snapshotWorkspace } from "../../workspaceTransfer/snapshot"
import { cleanupTempDirs, commitAll, gitOut, makeRepo, repoState, tempDir, writeFiles } from "./gitFixtures"

const bundles: TransferBundle[] = []
let workspacesDir: string
const originalWorkspacesDir = process.env.COGPIT_WORKSPACES_DIR

beforeEach(async () => {
  workspacesDir = await tempDir("cogpit-workspaces-")
  process.env.COGPIT_WORKSPACES_DIR = workspacesDir
})

afterEach(async () => {
  if (originalWorkspacesDir === undefined) delete process.env.COGPIT_WORKSPACES_DIR
  else process.env.COGPIT_WORKSPACES_DIR = originalWorkspacesDir
  await Promise.all(bundles.splice(0).map((bundle) => rm(bundle.path, { force: true })))
  await cleanupTempDirs()
})

async function bundleOf(repo: string, tip: string, exclude: string[] = []) {
  const bundle = await createBundle(repo, tip, exclude)
  if (bundle) bundles.push(bundle)
  return bundle
}

async function hubRepo() {
  const repo = await makeRepo({
    ".gitignore": "*.log\n",
    "packages/app/index.ts": "export const version = 1\n",
    "packages/app/README.md": "# app\n",
    "shared.txt": "shared\n",
  })
  await gitOut(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"])
  await writeFiles(repo, { "packages/app/index.ts": "export const version = 2\n", "notes/todo.md": "- ship\n", "hub.log": "x\n" })
  return repo
}

describe("createBundle", () => {
  it("bundles only what the receiver lacks, and nothing when it has the tip", async () => {
    const repo = await makeRepo({ "big.txt": "x".repeat(50_000) })
    const base = await gitOut(repo, ["rev-parse", "HEAD"])
    await writeFiles(repo, { "small.txt": "small\n" })
    const tip = await commitAll(repo, "second")

    const full = await bundleOf(repo, tip)
    const thin = await bundleOf(repo, tip, [base, "f".repeat(40)])

    expect(full).not.toBeNull()
    expect(thin).not.toBeNull()
    expect((await stat(thin!.path)).size).toBeLessThan((await stat(full!.path)).size)
    expect(thin!.ref).toMatch(/^refs\/cogpit\/transfer\/[0-9a-f]+$/)
    expect(await bundleOf(repo, tip, [tip])).toBeNull()
    expect(await gitOut(repo, ["for-each-ref", "refs/cogpit"])).toBe("")

    const receiver = await tempDir("cogpit-receiver-")
    await gitOut(receiver, ["init", "-q", "--bare"])
    await fetchBundle(receiver, full!.path, full!.ref, "refs/heads/received")
    expect(await gitOut(receiver, ["rev-parse", "refs/heads/received"])).toBe(tip)
  })
})

describe("device workspace store", () => {
  it("round-trips a dirty hub repo through a device worktree and back", async () => {
    const hub = await hubRepo()
    const hubBefore = await repoState(hub)
    const sent = await snapshotWorkspace(join(hub, "packages", "app"))
    expect(await knownCommits(sent.repoKey)).toEqual([])

    const bundle = await bundleOf(hub, sent.snapshot)
    const imported = await importWorkspace({
      repoKey: sent.repoKey,
      bundlePath: bundle!.path,
      bundleRef: bundle!.ref,
      snapshot: sent.snapshot,
      task: "Fix the bug!",
      subdir: sent.subdir,
    })

    expect(imported).toEqual({
      workspaceId: `${sent.repoKey}/Fix-the-bug`,
      path: join(workspacesDir, sent.repoKey, "Fix-the-bug"),
      cwd: join(workspacesDir, sent.repoKey, "Fix-the-bug", "packages", "app"),
      branch: "cogpit/Fix-the-bug",
    })
    expect((await readFile(join(imported.cwd, "index.ts"), "utf8")).replace(/\r\n/g, "\n")).toBe("export const version = 2\n")
    expect((await readFile(join(imported.path, "notes", "todo.md"), "utf8")).replace(/\r\n/g, "\n")).toBe("- ship\n")
    await expect(stat(join(imported.path, "hub.log"))).rejects.toThrow()
    expect(await gitOut(imported.path, ["status", "--porcelain"])).toBe("")
    expect(await knownCommits(sent.repoKey)).toContain(sent.snapshot)

    // The agent commits some work and leaves the rest uncommitted.
    await writeFiles(imported.path, { "packages/app/feature.ts": "export {}\n" })
    await commitAll(imported.path, "add feature")
    await writeFiles(imported.path, { "packages/app/index.ts": "export const version = 3\n", "wip.txt": "draft\n" })
    await rm(join(imported.path, "shared.txt"))

    const exported = await exportWorkspace(imported.workspaceId, [sent.head])
    expect(exported.dirty).toBe(true)
    expect(exported.bundle).not.toBeNull()
    bundles.push(exported.bundle!)
    expect(await gitOut(imported.path, ["diff", "--name-status"])).toBe("M\tpackages/app/index.ts\nD\tshared.txt")
    expect(await gitOut(imported.path, ["ls-files", "--others", "--exclude-standard"])).toBe("wip.txt")

    await fetchBundle(hub, exported.bundle!.path, exported.bundle!.ref, "refs/heads/cogpit/dev/task")
    expect(await gitOut(hub, ["rev-parse", "refs/heads/cogpit/dev/task"])).toBe(exported.tip)
    expect(await gitOut(hub, ["diff", "--name-status", `${sent.snapshot}..cogpit/dev/task`])).toBe(
      ["A\tpackages/app/feature.ts", "M\tpackages/app/index.ts", "D\tshared.txt", "A\twip.txt"].join("\n"),
    )
    expect(await repoState(hub)).toEqual(hubBefore)
  })

  it("imports a snapshot the device already has without a bundle, under a fresh name", async () => {
    const hub = await hubRepo()
    const sent = await snapshotWorkspace(hub)
    const bundle = await bundleOf(hub, sent.snapshot)
    const input = { repoKey: sent.repoKey, snapshot: sent.snapshot, task: "task", subdir: "" }
    const first = await importWorkspace({ ...input, bundlePath: bundle!.path, bundleRef: bundle!.ref })

    const second = await importWorkspace({ ...input, bundlePath: null, bundleRef: null })

    expect(first.workspaceId).toBe(`${sent.repoKey}/task`)
    expect(second).toMatchObject({ workspaceId: `${sent.repoKey}/task-2`, branch: "cogpit/task-2" })
    expect(await gitOut(second.path, ["rev-parse", "HEAD"])).toBe(sent.snapshot)
  })

  it("asks for a bundle when the device lacks the snapshot", async () => {
    const hub = await hubRepo()
    const sent = await snapshotWorkspace(hub)

    await expect(importWorkspace({
      repoKey: sent.repoKey,
      bundlePath: null,
      bundleRef: null,
      snapshot: sent.snapshot,
      task: "t",
      subdir: "",
    })).rejects.toMatchObject({ status: 409 })
  })

  it("exports nothing new when the receiver already has a clean workspace's tip", async () => {
    const hub = await hubRepo()
    const sent = await snapshotWorkspace(hub)
    const bundle = await bundleOf(hub, sent.snapshot)
    const imported = await importWorkspace({
      repoKey: sent.repoKey, bundlePath: bundle!.path, bundleRef: bundle!.ref, snapshot: sent.snapshot, task: "t", subdir: "",
    })

    expect(await exportWorkspace(imported.workspaceId, [sent.snapshot])).toEqual({
      tip: sent.snapshot,
      dirty: false,
      bundle: null,
    })
  })

  it("rejects workspace ids that are malformed or escape the workspaces folder", async () => {
    const key = "widgets-0123456789"
    for (const workspaceId of ["../etc", `${key}/..`, `${key}/../../etc`, `${key}/a/b`, `${key}/repo.git`, `${key}/.hidden`, `${key}/-rf`, "Bad Key/task", `${key}/`]) {
      await expect(exportWorkspace(workspaceId, []), workspaceId).rejects.toMatchObject({ status: 400 })
      await expect(removeWorkspace(workspaceId), workspaceId).rejects.toMatchObject({ status: 400 })
    }
    await expect(exportWorkspace(`${key}/missing`, [])).rejects.toMatchObject({ status: 404 })
    await expect(exportWorkspace(`${key}/t`, ["not-a-sha"])).rejects.toMatchObject({ status: 400 })
  })

  it("validates import input before touching disk", async () => {
    const valid = { repoKey: "widgets-0123456789", bundlePath: null, bundleRef: null, snapshot: "a".repeat(40), task: "t", subdir: "" }
    await expect(importWorkspace({ ...valid, repoKey: "../x" })).rejects.toMatchObject({ status: 400 })
    await expect(importWorkspace({ ...valid, snapshot: "HEAD" })).rejects.toMatchObject({ status: 400 })
    await expect(importWorkspace({ ...valid, subdir: "../outside" })).rejects.toMatchObject({ status: 400 })
    await expect(importWorkspace({ ...valid, subdir: "/abs" })).rejects.toMatchObject({ status: 400 })
    await expect(importWorkspace({ ...valid, bundlePath: "/tmp/x", bundleRef: "HEAD:refs/heads/x" })).rejects.toMatchObject({ status: 400 })
    await expect(stat(join(workspacesDir, valid.repoKey))).rejects.toThrow()
  })

  it("removes a workspace's worktree and branch", async () => {
    const hub = await hubRepo()
    const sent = await snapshotWorkspace(hub)
    const bundle = await bundleOf(hub, sent.snapshot)
    const imported = await importWorkspace({
      repoKey: sent.repoKey, bundlePath: bundle!.path, bundleRef: bundle!.ref, snapshot: sent.snapshot, task: "t", subdir: "",
    })
    const repoDir = join(workspacesDir, sent.repoKey, "repo.git")

    await removeWorkspace(imported.workspaceId)
    await removeWorkspace(imported.workspaceId)

    await expect(stat(imported.path)).rejects.toThrow()
    expect(await gitOut(repoDir, ["for-each-ref", "refs/heads", "refs/cogpit"])).toBe("")
  })
})

describe("sanitizeTaskName", () => {
  it.each([
    ["Fix the bug!", "Fix-the-bug"],
    ["../../etc/passwd", "etc-passwd"],
    ["-rf", "rf"],
    [".hidden", "hidden"],
    ["a..b", "a.b"],
    ["branch.lock", "branch"],
    ["", "task"],
    ["!!!", "task"],
    ["x".repeat(100), "x".repeat(64)],
  ])("%s -> %s", (label, expected) => {
    expect(sanitizeTaskName(label)).toBe(expected)
  })
})
