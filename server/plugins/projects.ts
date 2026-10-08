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

const DISCOVERY_TTL_MS = 30_000
const projectIdFor = (identity: string) => `p_${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`
type RefreshScope = { all: true } | { workspace: { path: string; inspection: ProjectInspection } } | { projectId: string }

function ownerOf(path: string, inspection: ProjectInspection, projects: PluginProject[]): PluginProject | undefined {
  let owner: PluginProject | undefined
  let longest = -1
  for (const project of projects) {
    for (const root of project.paths) {
      if (root.length > longest && isWithinDir(root, path)) {
        owner = project
        longest = root.length
      }
    }
  }
  return inspection.git && owner?.id !== projectIdFor(inspection.identity) ? undefined : owner
}

export class PluginProjects {
  private readonly now: () => number
  private projects: PluginProject[] = []
  private refreshedAt = -Infinity
  private pending: Promise<PluginProject[]> | null = null
  private inventory: { paths: string[]; readAt: number } | null = null
  private inventoryPending: Promise<string[]> | null = null
  private inspections = new Map<string, ProjectInspection>()
  private workspaces = new Map<string, Promise<{ projects: PluginProject[]; inspection: ProjectInspection | null }>>()

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  async list(force = false): Promise<PluginProject[]> {
    if (!force && this.now() - this.refreshedAt < DISCOVERY_TTL_MS) return structuredClone(this.projects)
    if (this.pending) return this.pending
    this.pending = this.refresh(true, { all: true }).finally(() => { this.pending = null })
    return this.pending
  }

  private inventoryPaths(fresh: boolean): Promise<string[]> {
    if (!fresh && this.inventory && this.now() - this.inventory.readAt < DISCOVERY_TTL_MS) return Promise.resolve(this.inventory.paths)
    this.inventoryPending ??= (async () => {
      const readAt = this.now()
      const inventories = await Promise.allSettled(allStores().map((store) => store.listProjects()))
      const paths = [...new Set(inventories.flatMap((result) => result.status === "fulfilled" ? result.value.map((project) => project.path) : []))].slice(0, 1024)
      this.inventory = { paths, readAt }
      return paths
    })().finally(() => { this.inventoryPending = null })
    return this.inventoryPending
  }

  private needsInspection(canonical: string, previous: ProjectInspection, scope: RefreshScope): boolean {
    if ("all" in scope) return true
    if ("projectId" in scope) return projectIdFor(previous.identity) === scope.projectId
    const { path, inspection } = scope.workspace
    return isWithinDir(canonical, path) || previous.paths.some(root => isWithinDir(root, path)) || previous.identity === inspection.identity
  }

  private async refresh(freshInventory: boolean, scope: RefreshScope): Promise<PluginProject[]> {
    const queue = [...await this.inventoryPaths(freshInventory)]
    const workspace = "workspace" in scope ? scope.workspace : null
    const known = new Map<string, PluginProject>()
    const inspections = new Map<string, ProjectInspection>()
    await Promise.all(Array.from({ length: Math.min(queue.length, 4) }, async () => {
      let path: string | undefined
      while ((path = queue.shift()) !== undefined) {
        const canonical = await canonicalDirectory(path)
        if (!canonical) continue
        const previous = this.inspections.get(canonical)
        const covered = workspace && (canonical === workspace.path
          || previous?.identity === workspace.inspection.identity && workspace.inspection.paths.some(root => isWithinDir(root, canonical)))
        const project = covered ? workspace.inspection
          : !previous || this.needsInspection(canonical, previous, scope) ? await inspectProject(canonical) : previous
        if (!project) continue
        inspections.set(canonical, project)
        const id = projectIdFor(project.identity)
        const existing = known.get(id)
        if (existing) existing.paths = [...new Set([...existing.paths, ...project.paths])].sort()
        else known.set(id, { id, name: basename(project.paths[0]) || "Project", paths: [...project.paths].sort() })
      }
    }))
    const projects = [...known.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    this.inspections = inspections
    if ("all" in scope) { this.projects = projects; this.refreshedAt = this.now() }
    return structuredClone(projects)
  }

  async resolve(id: string | null): Promise<PluginProject | null> {
    if (id === null) return null
    const project = (await this.refresh(false, { projectId: id })).find((candidate) => candidate.id === id)
      ?? (await this.refresh(true, { projectId: id })).find((candidate) => candidate.id === id)
    if (!project) throw new Error("The selected project is no longer available on this host")
    return project
  }

  async resolveWorkspace(projectId: string | null, workspacePath?: string | null): Promise<string | null> {
    if (workspacePath === undefined || workspacePath === null) return null
    const workspace = projectId ? await this.inspectWorkspace(workspacePath, projectId) : null
    if (!workspace || workspace.project.id !== projectId) throw new Error("The selected workspace is not available in this project")
    return workspace.path
  }

  async resolveContext(projectId: string | null, workspacePath?: string | null): Promise<{ project: PluginProject | null; workspacePath: string | null }> {
    if (!workspacePath) return { project: await this.resolve(projectId), workspacePath: null }
    const workspace = projectId ? await this.inspectWorkspace(workspacePath, projectId) : null
    if (!workspace || workspace.project.id !== projectId) throw new Error("The selected workspace is not available in this project")
    return { project: workspace.project, workspacePath: workspace.path }
  }

  async resolveWorkspaceProject(workspacePath: string): Promise<PluginProject | null> {
    return (await this.inspectWorkspace(workspacePath))?.project ?? null
  }

  private async inspectWorkspace(workspacePath: string, expectedId?: string): Promise<{ project: PluginProject; path: string } | null> {
    const canonical = await canonicalDirectory(workspacePath)
    if (!canonical) return null
    let pending = this.workspaces.get(canonical)
    if (!pending) {
      pending = inspectProject(canonical).then(async inspection => ({ projects: inspection ? await this.refresh(false, { workspace: { path: canonical, inspection } }) : [], inspection }))
        .finally(() => { this.workspaces.delete(canonical) })
      this.workspaces.set(canonical, pending)
    }
    const { projects, inspection } = await pending
    if (!inspection) return null
    let owner = ownerOf(canonical, inspection, projects)
    if (!owner || expectedId !== undefined && owner.id !== expectedId) owner = ownerOf(canonical, inspection, await this.refresh(true, { workspace: { path: canonical, inspection } }))
    return owner ? { project: owner, path: canonical } : null
  }
}
