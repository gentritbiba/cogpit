import { randomUUID } from "node:crypto"
import type { ActiveWorktreeStartup, StartupAuthorizationContext } from "../../shared/contracts/sessionStartup"
import { RouteError, ErrorCodes } from "../lib/routeError"
import { physicalDirectory, projectIdentity, validateInitializedDirectory } from "./project"

export interface StartupIdentity { sessionId?: string; cwd: string; nativeWorktree?: boolean }
export interface StartupLifecycle { signal: AbortSignal; beforeFirstTurn: (identity: StartupIdentity) => Promise<void> }

export interface WorktreeStartupContext {
  id: string
  /** The owner's command scope. */
  scope: string
  projectCwd: string
  worktreeName: string
  signal: AbortSignal
  authorize?: (context: StartupAuthorizationContext) => Promise<void>
}
/** One startup an installed extension takes part in. */
export interface WorktreeStartupRun {
  /** Runs in the initialized, prepared worktree before the first provider input; `validate` re-resolves the checkout. */
  ready(input: { cwd: string; sessionId?: string; validate: () => Promise<string> }): Promise<void>
  /** Records how the startup ended. */
  finish(outcome: { stage: "ready" | "cancelled" | "interrupted"; error?: string }): Promise<void>
}
/** The one optional step an installed plugin integration may add; `begin` returns null when it does nothing for this startup. */
export interface WorktreeStartupStep {
  begin(context: WorktreeStartupContext): Promise<{ run: WorktreeStartupRun; extension: { pluginId: string; name: string } } | null>
}

let registeredStep: WorktreeStartupStep | null = null
export function registerWorktreeStartupStep(step: WorktreeStartupStep): () => void {
  if (registeredStep) throw new Error("A worktree startup step is already registered")
  registeredStep = step
  return () => { if (registeredStep === step) registeredStep = null }
}

interface Active { scope: string; identity: string; status: ActiveWorktreeStartup; controller: AbortController; finished: Promise<void> }

/**
 * Generic worktree readiness: the first provider input waits until the
 * checkout is initialized, validated, prepared, any installed extension step
 * has finished, and the caller's authority has been checked again.
 */
export class WorktreeStartups {
  private active = new Map<string, Active>()

  async run<T>(options: {
    scope: string
    projectCwd: string
    worktreeName: string
    signal?: AbortSignal
    authorize?: (context: StartupAuthorizationContext) => Promise<void>
    /** Readies the initialized worktree, such as checking out a pinned commit, before any extension step. */
    prepare?: (cwd: string, signal: AbortSignal) => Promise<void>
    start: (lifecycle: StartupLifecycle) => Promise<T>
  }): Promise<T> {
    if (this.active.size >= 64) throw new RouteError(429, ErrorCodes.CONFLICT, "Too many worktree startups")
    const projectCwd = await physicalDirectory(options.projectCwd)
    const controller = new AbortController()
    const abort = () => controller.abort(new Error("Worktree startup cancelled. Worktree retained."))
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const expiry = setTimeout(() => controller.abort(new Error("Worktree startup expired after two hours. Worktree retained.")), 2 * 60 * 60_000)
    expiry.unref()
    let finished!: () => void
    const status: ActiveWorktreeStartup = { id: randomUUID(), worktreeName: options.worktreeName, stage: "initializing", createdAt: Date.now() }
    const entry: Active = { scope: options.scope, identity: "", status, controller, finished: new Promise<void>((resolve) => { finished = resolve }) }
    this.active.set(status.id, entry)
    let step: Awaited<ReturnType<WorktreeStartupStep["begin"]>> = null
    let ready: Promise<void> | undefined
    const beforeFirstTurn = (identity: StartupIdentity): Promise<void> => ready ??= (async () => {
      controller.signal.throwIfAborted()
      const resolve = () => identity.nativeWorktree ? physicalDirectory(identity.cwd) : validateInitializedDirectory(projectCwd, identity.cwd)
      const initialized = await resolve()
      const validate = async () => {
        const resolved = await resolve()
        if (initialized !== resolved) throw new Error("Initialized worktree path changed during setup")
        return resolved
      }
      if (options.prepare) {
        await options.prepare(initialized, controller.signal)
        await validate()
      }
      if (step) {
        status.stage = "extension"; status.extension = step.extension
        await step.run.ready({ cwd: initialized, sessionId: identity.sessionId, validate })
        controller.signal.throwIfAborted()
      }
      status.stage = "agent-start"; status.extension = undefined
      await validate()
      await options.authorize?.({ stage: "agent-start", cwd: initialized, projectCwd, sessionId: identity.sessionId })
      controller.signal.throwIfAborted()
    })()
    try {
      entry.identity = await projectIdentity(projectCwd)
      controller.signal.throwIfAborted()
      await options.authorize?.({ stage: "setup", cwd: projectCwd, projectCwd })
      controller.signal.throwIfAborted()
      step = await registeredStep?.begin({ id: status.id, scope: options.scope, projectCwd, worktreeName: options.worktreeName, signal: controller.signal, authorize: options.authorize }) ?? null
      controller.signal.throwIfAborted()
      const result = await options.start({ signal: controller.signal, beforeFirstTurn })
      if (!ready) throw new Error("Provider did not acknowledge worktree readiness; first prompt was not authorized")
      await ready
      controller.signal.throwIfAborted()
      await step?.run.finish({ stage: "ready" }).catch(() => {})
      return result
    } catch (error) {
      const cancelled = controller.signal.aborted
      controller.abort(error)
      if (ready) await ready.catch(() => {})
      await step?.run.finish({ stage: cancelled ? "cancelled" : "interrupted", error: error instanceof Error ? error.message : "Worktree startup failed" }).catch(() => {})
      throw error
    } finally {
      clearTimeout(expiry)
      options.signal?.removeEventListener("abort", abort)
      this.active.delete(status.id)
      finished()
    }
  }

  /** Startups of `scope` still running for the project containing `cwd`. */
  async list(scope: string, cwd: string): Promise<ActiveWorktreeStartup[]> {
    const identity = await projectIdentity(cwd)
    return [...this.active.values()].filter((entry) => entry.scope === scope && entry.identity === identity).map((entry) => structuredClone(entry.status))
  }

  cancel(scope: string, id: string): void {
    const entry = this.active.get(id)
    if (!entry || entry.scope !== scope) throw new RouteError(409, ErrorCodes.CONFLICT, "Startup is no longer active; inspect the retained worktree")
    entry.controller.abort(new Error("Worktree startup cancelled. Worktree retained."))
  }

  async close(): Promise<void> {
    const active = [...this.active.values()]
    for (const entry of active) entry.controller.abort(new Error("Server is shutting down. Worktree retained."))
    await Promise.allSettled(active.map((entry) => entry.finished))
  }
}
export const worktreeStartups = new WorktreeStartups()
