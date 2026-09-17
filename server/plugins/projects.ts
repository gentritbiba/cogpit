import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { allStores } from "../agents"
import { runGit } from "../lib/gitProject"
import { isWithinDir } from "../pathSafety"
import type { PluginProjectSummary } from "../../shared/contracts/pluginManagement"

export type PluginProject = PluginProjectSummary

interface ProjectInspection { identity: string; paths: string[]; git: boolean }

async function canonicalDirectory(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null
  try {
    const canonical = await realpath(path)
    return (await stat(canonical)).isDirectory() ? canonical : null
  } catch { return null }
}

async function inspectProject(canonical: string): Promise<ProjectInspection | null> {
  try {
    const results = await Promise.allSettled([
      runGit(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      runGit(canonical, ["rev-parse", "--show-toplevel"]),
      runGit(canonical, ["worktree", "list", "--porcelain", "-z"]),
    ])
    const [commonResult, topResult, worktrees] = results.map(result => {
      if (result.status === "rejected") throw result.reason
      return result.value
    })
    const common = await realpath(resolve(canonical, commonResult.stdout.trim()))
    const top = await realpath(topResult.stdout.trim())
    const paths: string[] = []
    for (const field of worktrees.stdout.split("\0")) {
      if (!field.startsWith("worktree ")) continue
      try {
        const member = await realpath(field.slice(9))
        if ((await stat(member)).isDirectory()) paths.push(member)
      } catch { /* Pruned worktrees are not available project scopes. */ }
    }
    const within = relative(top, canonical)
    if (!paths.includes(top) || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return null
    return { identity: common, paths, git: true }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code !== "ENOENT" && !/not a git repository/i.test(failure.stderr ?? "")) return null
    return { identity: canonical, paths: [canonical], git: false }
  }
}

export class PluginProjects {
  private projects: PluginProject[] = []
  private refreshedAt = 0
  private pending: Promise<PluginProject[]> | null = null
  private inspections = new Map<string, ProjectInspection>()
  private workspaces = new Map<string, Promise<{ projects: PluginProject[]; inspection: ProjectInspection | null }>>()

  async list(force = false): Promise<PluginProject[]> {
    if (!force && Date.now() - this.refreshedAt < 30_000) return structuredClone(this.projects)
    if (this.pending) return this.pending
    this.pending = this.refresh().finally(() => { this.pending = null })
    return this.pending
  }

  private async refresh(workspace?: string, workspaceInspection?: ProjectInspection | null): Promise<PluginProject[]> {
    const inventories = await Promise.allSettled(allStores().map((store) => store.listProjects()))
    const paths = new Set(inventories.flatMap((result) => result.status === "fulfilled" ? result.value.map((project) => project.path) : []))
    const known = new Map<string, PluginProject>()
    const inspections = new Map<string, ProjectInspection>()
    const queue = [...paths].slice(0, 1024)
    await Promise.all(Array.from({ length: Math.min(queue.length, 4) }, async () => {
      let path: string | undefined
      while ((path = queue.shift()) !== undefined) {
        const canonical = await canonicalDirectory(path)
        if (!canonical) continue
        const previous = this.inspections.get(canonical)
        const relevant = !workspace || !previous || isWithinDir(canonical, workspace)
          || previous.paths.some(root => isWithinDir(root, workspace)) || previous.identity === workspaceInspection?.identity
        const project = canonical === workspace ? workspaceInspection : relevant ? await inspectProject(canonical) : previous
        if (!project) continue
        inspections.set(canonical, project)
        const id = `p_${createHash("sha256").update(project.identity).digest("hex").slice(0, 40)}`
        const existing = known.get(id)
        if (existing) existing.paths = [...new Set([...existing.paths, ...project.paths])].sort()
        else known.set(id, { id, name: basename(project.paths[0]) || "Project", paths: project.paths.sort() })
      }
    }))
    const projects = [...known.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    this.inspections = inspections
    if (!workspace) { this.projects = projects; this.refreshedAt = Date.now() }
    return structuredClone(projects)
  }

  async resolve(id: string | null): Promise<PluginProject | null> {
    if (id === null) return null
    const project = (await this.list(true)).find((candidate) => candidate.id === id)
    if (!project) throw new Error("The selected project is no longer available on this host")
    return project
  }

  async resolveWorkspace(projectId: string | null, workspacePath?: string | null): Promise<string | null> {
    if (workspacePath === undefined || workspacePath === null) return null
    const workspace = projectId ? await this.inspectWorkspace(workspacePath) : null
    if (!workspace || workspace.project.id !== projectId) throw new Error("The selected workspace is not available in this project")
    return workspace.path
  }

  async resolveContext(projectId: string | null, workspacePath?: string | null): Promise<{ project: PluginProject | null; workspacePath: string | null }> {
    if (!workspacePath) return { project: await this.resolve(projectId), workspacePath: null }
    const workspace = projectId ? await this.inspectWorkspace(workspacePath) : null
    if (!workspace || workspace.project.id !== projectId) throw new Error("The selected workspace is not available in this project")
    return { project: workspace.project, workspacePath: workspace.path }
  }

  async resolveWorkspaceProject(workspacePath: string): Promise<PluginProject | null> {
    return (await this.inspectWorkspace(workspacePath))?.project ?? null
  }

  private async inspectWorkspace(workspacePath: string): Promise<{ project: PluginProject; path: string } | null> {
    const canonical = await canonicalDirectory(workspacePath)
    if (!canonical) return null
    let pending = this.workspaces.get(canonical)
    if (!pending) {
      pending = inspectProject(canonical).then(async inspection => ({ projects: await this.refresh(canonical, inspection), inspection }))
        .finally(() => { this.workspaces.delete(canonical) })
      this.workspaces.set(canonical, pending)
    }
    const { projects, inspection } = await pending
    if (!inspection) return null
    let owner: PluginProject | undefined
    let longest = -1
    for (const project of projects) {
      for (const path of project.paths) {
        if (path.length > longest && isWithinDir(path, canonical)) {
          owner = project
          longest = path.length
        }
      }
    }
    if (inspection.git && owner?.id !== `p_${createHash("sha256").update(inspection.identity).digest("hex").slice(0, 40)}`) return null
    return owner ? { project: owner, path: canonical } : null
  }
}
