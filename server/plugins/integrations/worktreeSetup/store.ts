import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { getDataRoot } from "../../../config"
import { writeOwnerOnlyJson } from "../../../atomicJsonFile"
import { projectIdentity, physicalDirectory } from "../../../sessionStartup/project"
import { RouteError, ErrorCodes } from "../../../lib/routeError"
import { WORKTREE_SETUP_COMMAND_LIMIT, WORKTREE_SETUP_DEFAULT_TIMEOUT_MS, WORKTREE_SETUP_MAX_TIMEOUT_MS, worktreeSetupActive, type WorktreeSetupOperation as PublicOperation, type WorktreeSetupRecipe, type WorktreeSetupSnapshot } from "@cogpit/plugin-integrations"

/** The saved form keeps host paths and the session id; plugins receive `publicSnapshot`. */
export interface WorktreeSetupOperation extends PublicOperation { projectCwd: string; cwd?: string; sessionId?: string }
interface ProjectState { recipe: WorktreeSetupRecipe | null; operations: WorktreeSetupOperation[] }
export interface SetupProject { key: string; cwd: string; scope: string; state: ProjectState }

export function publicSnapshot(project: SetupProject): WorktreeSetupSnapshot {
  return structuredClone({
    recipe: project.state.recipe,
    operations: project.state.operations.map(({ projectCwd: _projectCwd, cwd: _cwd, sessionId: _sessionId, ...operation }) => operation),
  })
}

/** Recipes and history stay in `<data>/worktree-setup/`, where earlier releases kept them; disabling or uninstalling the plugin never removes them. */
export class WorktreeSetupStore {
  private loaded = new Map<string, Promise<SetupProject>>()
  private configurations = new Map<string, Promise<void>>()
  private writes = new Map<string, Promise<void>>()
  constructor(private root = () => join(getDataRoot(), "worktree-setup")) {}

  async project(scope: string, cwd: string): Promise<SetupProject> {
    const physical = await physicalDirectory(cwd)
    const identity = await projectIdentity(physical)
    const key = join(this.root(), createHash("sha256").update(JSON.stringify([scope, identity])).digest("hex") + ".json")
    let loading = this.loaded.get(key)
    if (!loading) {
      loading = (async () => {
        let state: ProjectState = { recipe: null, operations: [] }
        try {
          state = JSON.parse(await readFile(key, "utf8")) as ProjectState
          if (!Array.isArray(state.operations)) throw new Error("Invalid setup history")
          for (const operation of state.operations) if (worktreeSetupActive(operation.stage)) {
            operation.stage = "interrupted"
            operation.error = "Server stopped during startup. Worktree retained; inspect it before starting another session."
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        return { key, cwd: physical, scope, state }
      })()
      this.loaded.set(key, loading)
      void loading.catch(() => this.loaded.delete(key))
    }
    return { ...await loading, cwd: physical }
  }

  async save(project: SetupProject): Promise<void> {
    const bytes = JSON.stringify(project.state)
    const previous = this.writes.get(project.key) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      await mkdir(this.root(), { recursive: true, mode: 0o700 })
      await writeOwnerOnlyJson(project.key, JSON.parse(bytes))
    })
    this.writes.set(project.key, write)
    try { await write } finally { if (this.writes.get(project.key) === write) this.writes.delete(project.key) }
  }

  async configure(project: SetupProject, input: { command?: unknown; trusted?: unknown; timeoutMs?: unknown }): Promise<void> {
    if (typeof input.command !== "string" || input.command.length > WORKTREE_SETUP_COMMAND_LIMIT || input.command.includes("\0")) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Setup command must be at most 8000 characters")
    const command = input.command.trim()
    if (command && input.trusted !== true) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Explicit trust is required to save a setup command")
    const timeoutMs = input.timeoutMs ?? WORKTREE_SETUP_DEFAULT_TIMEOUT_MS
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > WORKTREE_SETUP_MAX_TIMEOUT_MS) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Setup timeout must be between 1 second and 60 minutes")
    const recipe = command ? { command, timeoutMs, revision: randomUUID(), configuredAt: Date.now() } : null
    const preceding = this.configurations.get(project.key) ?? Promise.resolve()
    const mutation = preceding.catch(() => {}).then(async () => {
      const previous = project.state.recipe
      project.state.recipe = recipe
      try { await this.save(project) } catch (error) { project.state.recipe = previous; throw error }
    })
    this.configurations.set(project.key, mutation)
    try { await mutation } finally { if (this.configurations.get(project.key) === mutation) this.configurations.delete(project.key) }
  }
}
export const worktreeSetupStore = new WorktreeSetupStore()
