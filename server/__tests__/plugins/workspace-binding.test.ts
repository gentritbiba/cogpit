// @vitest-environment node
import { ChildProcess, execFile as callbackExecFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const inventory = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock("../../agents", () => ({ allStores: () => [{ listProjects: async () => inventory.paths.map((path, index) => ({ dirName: `inventory-${index}`, path, sessionCount: 1, lastModified: null })) }] }))
vi.mock("../../lib/gitProject", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/gitProject")>()
  return { ...actual, runGit: vi.fn(actual.runGit) }
})
import { PluginProjects } from "../../plugins/projects"
import { runGit } from "../../lib/gitProject"

const execFile = promisify(callbackExecFile)
let root: string
let projects: PluginProjects
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cogpit-workspace-binding-")))
  inventory.paths = []
  projects = new PluginProjects()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function directory(name: string) { const path = join(root, name); await mkdir(path, { recursive: true }); return path }
async function idFor(path: string) {
  const project = (await projects.list(true)).find(value => value.paths.includes(path))
  expect(project).toBeDefined()
  return project!.id
}
async function git(cwd: string, ...args: string[]) {
  await execFile("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd, timeout: 10_000 })
}

describe("exact plugin workspace binding", { timeout: process.platform === "win32" ? 20_000 : 5_000 }, () => {
  it("waits for every Git process before returning a non-repository project", async () => {
    const selected = await directory("selected")
    inventory.paths = [selected]
    let finishSecond!: () => void
    let finishThird!: () => void
    vi.mocked(runGit)
      .mockRejectedValueOnce({ stderr: "fatal: not a git repository" })
      .mockReturnValueOnce(Object.assign(new Promise<{ stdout: string; stderr: string }>(resolve => { finishSecond = () => resolve({ stdout: "", stderr: "" }) }), { child: new ChildProcess() }))
      .mockReturnValueOnce(Object.assign(new Promise<{ stdout: string; stderr: string }>(resolve => { finishThird = () => resolve({ stdout: "", stderr: "" }) }), { child: new ChildProcess() }))
    let completed = false
    const pending = projects.list().then(value => { completed = true; return value })
    try {
      await vi.waitFor(() => expect(finishThird).toBeTypeOf("function"))
      expect(completed).toBe(false)
      finishSecond()
      await new Promise(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
    } finally {
      finishSecond?.()
      finishThird?.()
    }
    expect((await pending)[0].paths).toEqual([selected])
  })

  it("validates the selected workspace without running Git against unrelated projects again", async () => {
    const selected = await directory("selected"), unrelated = await directory("unrelated")
    inventory.paths = [selected, unrelated]
    const id = await idFor(selected)
    vi.mocked(runGit).mockClear()
    expect(await projects.resolveWorkspace(id, selected)).toBe(selected)
    expect(vi.mocked(runGit).mock.calls.length).toBeGreaterThan(0)
    expect(vi.mocked(runGit).mock.calls.every(([cwd]) => cwd === selected)).toBe(true)
    inventory.paths = [unrelated]
    await expect(projects.resolveWorkspace(id, selected)).rejects.toThrow(/workspace/)
  })

  it("detects a newly added worktree from a previously unrelated repository", async () => {
    const outer = await directory("outer"), repository = await directory("repository")
    await git(repository, "init", "--initial-branch=main")
    await git(repository, "commit", "--allow-empty", "-m", "Fixture")
    inventory.paths = [outer, repository]
    const outerId = await idFor(outer), repositoryId = await idFor(repository)
    const linked = join(outer, "new-worktree")
    await git(repository, "worktree", "add", "-b", "feature", linked)
    await expect(projects.resolveWorkspace(outerId, linked)).rejects.toThrow(/workspace/)
    expect(await projects.resolveWorkspace(repositoryId, linked)).toBe(linked)
  })
  it("keeps absent workspace paths compatible with existing callers", async () => {
    expect(await projects.resolveWorkspace(null)).toBeNull()
    expect(await projects.resolveWorkspace(null, null)).toBeNull()
    expect(await projects.resolveWorkspace("existing-project", null)).toBeNull()
  })

  it("keeps the exact nested directory and canonicalizes an alias within its project", async () => {
    const project = await directory("project"), nested = await directory("project/packages/frontend")
    const alias = join(root, "workspace-alias")
    await symlink(nested, alias, "dir")
    inventory.paths = [project]
    const id = await idFor(project)
    expect(await projects.resolveWorkspace(id, nested)).toBe(nested)
    expect(await projects.resolveWorkspace(id, alias)).toBe(nested)
    expect(await projects.resolveWorkspace(id, join(nested, "..", "frontend"))).toBe(nested)
  })

  it("keeps linked worktrees distinct while granting both through their shared project identity", async () => {
    const repository = await directory("z-main"), linked = join(root, "a-linked")
    await git(repository, "init", "--initial-branch=main")
    await git(repository, "commit", "--allow-empty", "-m", "Fixture")
    await git(repository, "worktree", "add", "-b", "feature", linked)
    const nested = await directory("a-linked/client")
    inventory.paths = [repository, linked]
    const id = await idFor(repository)
    expect(await idFor(linked)).toBe(id)
    expect(await projects.resolveWorkspace(id, repository)).toBe(repository)
    expect(await projects.resolveWorkspace(id, linked)).toBe(linked)
    expect(await projects.resolveWorkspace(id, nested)).toBe(nested)
  })

  it("uses the longest owning project root instead of an enclosing project grant", async () => {
    const outer = await directory("outer"), inner = await directory("outer/inner"), nested = await directory("outer/inner/src")
    inventory.paths = [outer, inner]
    const outerId = await idFor(outer), innerId = await idFor(inner)
    await expect(projects.resolveWorkspace(outerId, nested)).rejects.toThrow(/workspace/)
    expect(await projects.resolveWorkspace(innerId, nested)).toBe(nested)
  })

  it("rejects another project and a sibling sharing the same path prefix", async () => {
    const project = await directory("project"), sibling = await directory("project-other"), other = await directory("other")
    inventory.paths = [project, other]
    const id = await idFor(project)
    await expect(projects.resolveWorkspace(id, sibling)).rejects.toThrow(/workspace/)
    await expect(projects.resolveWorkspace(id, other)).rejects.toThrow(/workspace/)
    await expect(projects.resolveWorkspace(null, project)).rejects.toThrow(/workspace/)
    await expect(projects.resolveWorkspace("unknown-project", project)).rejects.toThrow(/workspace/)
  })

  it("rejects empty, relative, missing and file paths", async () => {
    const project = await directory("project"), file = join(project, "file.txt")
    await writeFile(file, "fixture")
    inventory.paths = [project]
    const id = await idFor(project)
    for (const path of ["", "relative", join(project, "missing"), file]) await expect(projects.resolveWorkspace(id, path)).rejects.toThrow(/workspace/)
  })

  it("rejects a project-local symlink escaping the granted project", async () => {
    const project = await directory("project"), outside = await directory("outside"), alias = join(project, "escape")
    await symlink(outside, alias, "dir")
    inventory.paths = [project]
    await expect(projects.resolveWorkspace(await idFor(project), alias)).rejects.toThrow(/workspace/)
  })

  it("rechecks fresh inventory when a nested workspace acquires another project owner", async () => {
    const outer = await directory("outer"), inner = await directory("outer/inner")
    inventory.paths = [outer]
    const id = await idFor(outer)
    expect(await projects.resolveWorkspace(id, inner)).toBe(inner)
    inventory.paths = [outer, inner]
    await expect(projects.resolveWorkspace(id, inner)).rejects.toThrow(/workspace/)
    inventory.paths = []
    await expect(projects.resolveWorkspace(id, outer)).rejects.toThrow(/workspace/)
  })

  it("rechecks a previously accepted workspace alias after its target changes", async () => {
    const project = await directory("project"), outside = await directory("outside"), alias = join(root, "alias")
    await symlink(project, alias, "dir")
    inventory.paths = [project]
    const id = await idFor(project)
    expect(await projects.resolveWorkspace(id, alias)).toBe(project)
    await rm(alias)
    await symlink(outside, alias, "dir")
    await expect(projects.resolveWorkspace(id, alias)).rejects.toThrow(/workspace/)
  })
})
