import { randomUUID } from "node:crypto"
import { WORKTREE_SETUP_OUTPUT_LIMIT, worktreeSetupActive, type StartupAuthorizationContext, type WorktreeSetupOperation } from "../../shared/contracts/worktreeSetup"
import { RouteError, ErrorCodes } from "../lib/routeError"
import { runSetupCommand } from "./command"
import { physicalDirectory, validateInitializedDirectory } from "./project"
import { worktreeSetupStore, type SetupProject, type WorktreeSetupStore } from "./store"

interface ActiveSetup { controller: AbortController; retry?: () => void; finished: Promise<void> }
export class WorktreeSetupService {
  private active = new Map<string, ActiveSetup>()
  constructor(readonly store: WorktreeSetupStore = worktreeSetupStore) {}

  async run<T>(options: {
    project: SetupProject
    worktreeName: string
    signal?: AbortSignal
    authorize?: (context: StartupAuthorizationContext) => Promise<void>
    start: (lifecycle: { signal: AbortSignal; beforeFirstTurn: (identity: { sessionId?: string; cwd: string; nativeWorktree?: boolean }) => Promise<void> }) => Promise<T>
  }): Promise<T> {
    if (this.active.size >= 64) throw new RouteError(429, ErrorCodes.CONFLICT, "Too many worktree startups")
    const controller = new AbortController()
    const abort = () => controller.abort(new Error("Worktree startup cancelled. Worktree retained."))
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const operation: WorktreeSetupOperation = { id: randomUUID(), projectCwd: options.project.cwd, worktreeName: options.worktreeName, stage: "initializing", attempt: 0, output: "", outputTruncated: false, createdAt: Date.now(), updatedAt: Date.now() }
    const startupTimeout = setTimeout(() => controller.abort(new Error("Worktree startup expired after two hours. Worktree retained.")), 2 * 60 * 60_000)
    startupTimeout.unref()
    let finished!: () => void
    const active: ActiveSetup = { controller, finished: new Promise<void>((resolve) => { finished = resolve }) }
    this.active.set(operation.id, active)
    const history = options.project.state.operations
    history.unshift(operation)
    while (history.length > 20) {
      const index = history.findLastIndex((entry) => !this.active.has(entry.id))
      if (index < 0) break
      history.splice(index, 1)
    }
    let flushing: ReturnType<typeof setTimeout> | undefined
    const save = async () => { operation.updatedAt = Date.now(); await this.store.save(options.project) }
    const output = (text: string) => {
      if (!text) return
      operation.output += text
      if (operation.output.length > WORKTREE_SETUP_OUTPUT_LIMIT) { operation.output = operation.output.slice(-WORKTREE_SETUP_OUTPUT_LIMIT); operation.outputTruncated = true }
      if (!flushing) flushing = setTimeout(() => { flushing = undefined; void save().catch(() => controller.abort(new Error("Unable to save setup progress"))) }, 200)
    }
    let ready: Promise<void> | undefined
    const beforeFirstTurn = (identity: { sessionId?: string; cwd: string; nativeWorktree?: boolean }): Promise<void> => ready ??= (async () => {
      controller.signal.throwIfAborted()
      const validate = async () => {
        const resolved = identity.nativeWorktree ? await physicalDirectory(identity.cwd) : await validateInitializedDirectory(options.project.cwd, identity.cwd)
        if (operation.cwd && operation.cwd !== resolved) throw new Error("Initialized worktree path changed during setup")
        return resolved
      }
      operation.cwd = await validate()
      operation.sessionId = identity.sessionId
      for (;;) {
        controller.signal.throwIfAborted()
        const recipe = options.project.state.recipe
        if (!recipe) break
        await validate()
        controller.signal.throwIfAborted()
        operation.stage = "setup"; operation.attempt++; operation.command = recipe.command
        operation.error = undefined; operation.exitCode = undefined
        await save()
        await options.authorize?.({ stage: "setup", cwd: operation.cwd, projectCwd: options.project.cwd, sessionId: identity.sessionId })
        controller.signal.throwIfAborted()
        let commandError: string | undefined
        try {
          operation.exitCode = await runSetupCommand({ cwd: operation.cwd, command: recipe.command, timeoutMs: recipe.timeoutMs, signal: controller.signal, output })
          if (operation.exitCode !== 0) commandError = `Setup command exited with code ${operation.exitCode ?? "unknown"}`
        } catch (error) {
          controller.signal.throwIfAborted()
          commandError = error instanceof Error ? error.message : "Setup command failed"
        }
        if (!commandError) break
        operation.stage = "failed"; operation.error = commandError
        // Install the retry waiter before publishing the failed stage.
        const decision = new Promise<void>((resolve, reject) => {
          const aborted = () => { active.retry = undefined; reject(controller.signal.reason) }
          active.retry = () => { active.retry = undefined; controller.signal.removeEventListener("abort", aborted); resolve() }
          controller.signal.addEventListener("abort", aborted, { once: true })
          if (controller.signal.aborted) aborted()
        })
        void decision.catch(() => {})
        await save()
        await decision
      }
      operation.stage = "agent-start"; operation.error = undefined
      await save()
      await validate()
      await options.authorize?.({ stage: "agent-start", cwd: operation.cwd, projectCwd: options.project.cwd, sessionId: identity.sessionId })
      controller.signal.throwIfAborted()
    })()
    try {
      await save()
      controller.signal.throwIfAborted()
      await options.authorize?.({ stage: "setup", cwd: options.project.cwd, projectCwd: options.project.cwd })
      const starting = options.start({ signal: controller.signal, beforeFirstTurn })
      const result = await starting
      if (!ready) throw new Error("Provider did not acknowledge worktree readiness; first prompt was not authorized")
      await ready
      controller.signal.throwIfAborted()
      operation.stage = "ready"
      return result
    } catch (error) {
      const cancelled = controller.signal.aborted
      controller.abort(error)
      if (ready) await ready.catch(() => {})
      operation.stage = cancelled ? "cancelled" : "interrupted"
      operation.error = error instanceof Error ? error.message : "Worktree startup failed"
      throw error
    } finally {
      clearTimeout(startupTimeout)
      if (flushing) clearTimeout(flushing)
      options.signal?.removeEventListener("abort", abort)
      this.active.delete(operation.id)
      try { await save() } finally { finished() }
    }
  }

  act(project: SetupProject, id: string, action: "retry" | "cancel"): void {
    const operation = project.state.operations.find((entry) => entry.id === id)
    const active = operation && this.active.get(id)
    if (!operation || !active || !worktreeSetupActive(operation.stage)) throw new RouteError(409, ErrorCodes.CONFLICT, "Startup is no longer active; inspect the retained worktree")
    if (action === "cancel") active.controller.abort(new Error("Worktree startup cancelled. Worktree retained."))
    else if (operation.stage === "failed" && active.retry) {
      operation.stage = "setup"
      active.retry()
    } else throw new RouteError(409, ErrorCodes.CONFLICT, "Setup is not waiting for a retry")
  }

  async close(): Promise<void> {
    const active = [...this.active.values()]
    for (const entry of active) entry.controller.abort(new Error("Server is shutting down. Worktree retained."))
    await Promise.allSettled(active.map((entry) => entry.finished))
  }
}
export const worktreeSetupService = new WorktreeSetupService()
