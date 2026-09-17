// @vitest-environment node
import { execFile as callbackExecFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const inventory = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock("../../agents", () => ({ allStores: () => [{ listProjects: async () => inventory.paths.map((path, index) => ({ dirName: `inventory-${index}`, path, sessionCount: 1, lastModified: null })) }] }))
import { PluginProjects } from "../../plugins/projects"

const execFile = promisify(callbackExecFile)
let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "cogpit-plugin-projects-"))); inventory.paths = [] })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function git(cwd: string, ...args: string[]) {
  return execFile("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd, timeout: 10_000 })
}
async function repository() {
  const repo = join(root, "repo")
  await mkdir(repo)
  await git(repo, "init", "--initial-branch=main")
  await git(repo, "commit", "--allow-empty", "-m", "Fixture")
  return repo
}

describe("host-owned plugin project identities", () => {
  it("canonicalizes inventory aliases and accepts only opaque project IDs", async () => {
    const directory = join(root, "plain")
    const alias = join(root, "alias")
    await mkdir(directory)
    await symlink(directory, alias, "dir")
    inventory.paths = [directory, alias, "relative-project", join(root, "missing")]
    const projects = new PluginProjects()
    const list = await projects.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toMatch(/^p_[a-f0-9]{40}$/)
    expect(list[0]!.paths).toEqual([directory])
    expect(await projects.resolve(list[0]!.id)).toEqual(list[0])
    await expect(projects.resolve(directory)).rejects.toThrow(/no longer available/)
    expect(await projects.resolve(null)).toBeNull()
    list[0]!.paths.push("caller-injected")
    expect((await projects.list())[0]!.paths).toEqual([directory])
  })

  it("groups verified linked worktrees on arbitrary branch names under one project ID", async () => {
    const repo = await repository()
    const linked = join(root, "linked")
    await git(repo, "worktree", "add", "-b", "arbitrary-branch", linked)
    inventory.paths = [repo, linked]
    const projects = new PluginProjects()
    const list = await projects.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.paths).toEqual([linked, repo].sort())
    inventory.paths = [linked]
    expect((await projects.list(true))[0]!.id).toBe(list[0]!.id)
  })

  it("resolves a recorded repository subdirectory to its verified worktree identity", async () => {
    const repo = await repository()
    const nested = join(repo, "nested")
    await mkdir(nested)
    inventory.paths = [repo]
    const projects = new PluginProjects()
    const expected = (await projects.list())[0]!
    inventory.paths = [nested]
    const list = await projects.list(true)
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(expected.id)
    expect(list[0]!.paths).toEqual([repo])
  })

  it("revalidates scope resolution when a project disappears from host inventory", async () => {
    const directory = join(root, "plain")
    await mkdir(directory)
    inventory.paths = [directory]
    const projects = new PluginProjects()
    const id = (await projects.list())[0]!.id
    inventory.paths = []
    await expect(projects.resolve(id)).rejects.toThrow(/no longer available/)
  })

  it("does not carry an approved symlink identity across a changed target", async () => {
    const first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias")
    await mkdir(first)
    await mkdir(second)
    await symlink(first, alias, "dir")
    inventory.paths = [alias]
    const projects = new PluginProjects()
    const firstId = (await projects.list())[0]!.id
    await rm(alias)
    await symlink(second, alias, "dir")
    await expect(projects.resolve(firstId)).rejects.toThrow(/no longer available/)
    expect((await projects.list())[0]!.paths).toEqual([second])
  })
})
