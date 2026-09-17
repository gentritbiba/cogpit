// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runGit } from "../../lib/gitProject"
import { resolveLinkedVercelProject } from "../../plugins/integrations/vercel"

let directory: string
let repository: string
async function link(root: string, name: string) {
  await mkdir(join(root, ".vercel"), { recursive: true })
  await writeFile(join(root, ".vercel", "project.json"), JSON.stringify({ projectId: `prj_${name}`, orgId: "team_test", projectName: name }))
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "cogpit-vercel-project-")))
  repository = join(directory, "repository")
  await mkdir(repository)
  await runGit(repository, ["init"])
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe("Vercel workspace links", () => {
  it("finds the repository link from a nested session directory", async () => {
    const cwd = join(repository, ".agent-artifacts", "spec-scouting")
    await mkdir(cwd, { recursive: true })
    await link(repository, "cms")
    await expect(resolveLinkedVercelProject(cwd)).resolves.toMatchObject({ root: repository, projectId: "prj_cms" })
  })

  it("prefers the nearest app link and then an exact session link", async () => {
    const app = join(repository, "apps", "web"), cwd = join(app, "src")
    await mkdir(cwd, { recursive: true })
    await link(repository, "repo")
    await link(app, "app")
    await expect(resolveLinkedVercelProject(cwd)).resolves.toMatchObject({ root: app, projectId: "prj_app" })
    await link(cwd, "session")
    await expect(resolveLinkedVercelProject(cwd)).resolves.toMatchObject({ root: cwd, projectId: "prj_session" })
  })

  it("does not fall back past a malformed app link", async () => {
    const app = join(repository, "app"), cwd = join(app, "src")
    await mkdir(cwd, { recursive: true })
    await link(repository, "repo")
    await link(app, "app")
    await writeFile(join(app, ".vercel", "project.json"), "invalid")
    await expect(resolveLinkedVercelProject(cwd)).rejects.toMatchObject({ code: "vercel_project_unlinked", message: "Unable to read this project's .vercel/project.json link" })
  })

  it("does not inherit links across nested repository boundaries", async () => {
    const nested = join(repository, "nested"), cwd = join(nested, "src")
    await mkdir(cwd, { recursive: true })
    await runGit(nested, ["init"])
    await link(repository, "outer")
    await expect(resolveLinkedVercelProject(cwd)).rejects.toMatchObject({ code: "vercel_project_unlinked" })
  })

  it("does not inherit the enclosing main repository link into a linked worktree", async () => {
    await runGit(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"])
    const worktree = join(repository, "worktrees", "feature"), cwd = join(worktree, "src")
    await runGit(repository, ["worktree", "add", "-b", "feature", worktree])
    await mkdir(cwd)
    await link(repository, "main")
    await expect(resolveLinkedVercelProject(cwd)).rejects.toMatchObject({ code: "vercel_project_unlinked" })
    await link(worktree, "feature")
    await expect(resolveLinkedVercelProject(cwd)).resolves.toMatchObject({ root: worktree, projectId: "prj_feature" })
  })

  it("uses the canonical directory for a symlinked session", async () => {
    const cwd = join(repository, "src"), alias = join(directory, "alias")
    await mkdir(cwd)
    await symlink(cwd, alias, "dir")
    await link(directory, "unrelated")
    await link(repository, "repo")
    await expect(resolveLinkedVercelProject(alias)).resolves.toMatchObject({ root: repository, projectId: "prj_repo" })
  })

  it("reads a newly created or changed link without restarting the host", async () => {
    const cwd = join(repository, "src")
    await mkdir(cwd)
    await expect(resolveLinkedVercelProject(cwd)).rejects.toMatchObject({ code: "vercel_project_unlinked" })
    await link(repository, "first")
    await expect(resolveLinkedVercelProject(cwd)).resolves.toMatchObject({ projectId: "prj_first" })
    await link(repository, "second")
    await expect(resolveLinkedVercelProject(cwd)).resolves.toMatchObject({ projectId: "prj_second" })
  })

  it("does not resolve canceled work", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(resolveLinkedVercelProject(repository, abort.signal)).rejects.toThrow()
  })
})
