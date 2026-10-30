import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { WorktreeSetupIntegrationRequest } from "@cogpit/plugin-contracts"
import { WORKTREE_SETUP_OUTPUT_LIMIT, worktreeSetupActive, type WorktreeSetupProposal, type WorktreeSetupScripts, type WorktreeSetupSnapshot } from "@cogpit/plugin-integrations"
import { discoverScripts } from "../../../routes/scripts/discovery"
import { RouteError, ErrorCodes } from "../../../lib/routeError"
import { assertWorktreeStartCapabilities } from "../../../sessionStartup/authorization"
import { physicalDirectory } from "../../../sessionStartup/project"
import type { WorktreeStartupContext, WorktreeStartupStep } from "../../../sessionStartup/readiness"
import { runSetupCommand } from "./command"
import { publicSnapshot, worktreeSetupStore, type SetupProject, type WorktreeSetupOperation, type WorktreeSetupStore } from "./store"

/** The installed, enabled, release-provenance plugin granted `worktreeSetup` whose scope covers a project. */
export interface WorktreeSetupGrant { pluginId: string; digest: string; name: string }
export interface WorktreeSetupGate { current(projectCwd: string): Promise<WorktreeSetupGrant | null> }
/** What a frame request runs as: its plugin, owner, workspace and the live request that carries the owner's capabilities. */
export interface WorktreeSetupCaller { pluginId: string; principal: string; workspacePath: string; request: IncomingMessage; authorize(): Promise<void> }

interface Run { pluginId: string; controller: AbortController; retry?: () => void; cancelled?: boolean }
interface Proposal { pluginId: string; scope: string; workspacePath: string; command: string; timeoutMs: number; expiresAt: number }
const PROPOSAL_TTL_MS = 10 * 60_000
const DISABLED = "Worktree setup plugin was disabled or changed. Worktree retained."
/** Plugin principals name the local owner `owner`; command scopes name it `local`. */
export const scopeOfPrincipal = (principal: string) => principal === "owner" ? "local" : principal

export class WorktreeSetupService {
  private runs = new Map<string, Run>()
  private proposals = new Map<string, Proposal>()
  constructor(private readonly gate: WorktreeSetupGate, readonly store: WorktreeSetupStore = worktreeSetupStore) {}

  readonly step: WorktreeStartupStep = { begin: (context) => this.begin(context) }

  private async begin(context: WorktreeStartupContext) {
    const grant = await this.gate.current(context.projectCwd)
    if (!grant) return null
    const project = await this.store.project(context.scope, context.projectCwd)
    const check = async () => {
      const current = await this.gate.current(context.projectCwd)
      if (current?.pluginId !== grant.pluginId || current.digest !== grant.digest) throw new Error(DISABLED)
    }
    const operation: WorktreeSetupOperation = { id: context.id, projectCwd: project.cwd, worktreeName: context.worktreeName, stage: "initializing", attempt: 0, output: "", outputTruncated: false, createdAt: Date.now(), updatedAt: Date.now() }
    const controller = new AbortController()
    const signal = AbortSignal.any([context.signal, controller.signal])
    const run: Run = { pluginId: grant.pluginId, controller }
    this.runs.set(operation.id, run)
    const history = project.state.operations
    history.unshift(operation)
    while (history.length > 20) {
      const index = history.findLastIndex((entry) => !this.runs.has(entry.id))
      if (index < 0) break
      history.splice(index, 1)
    }
    let flushing: ReturnType<typeof setTimeout> | undefined
    const save = async () => { operation.updatedAt = Date.now(); await this.store.save(project) }
    const output = (text: string) => {
      if (!text) return
      operation.output += text
      if (operation.output.length > WORKTREE_SETUP_OUTPUT_LIMIT) { operation.output = operation.output.slice(-WORKTREE_SETUP_OUTPUT_LIMIT); operation.outputTruncated = true }
      if (!flushing) flushing = setTimeout(() => { flushing = undefined; void save().catch(() => controller.abort(new Error("Unable to save setup progress"))) }, 200)
    }
    try { await save() } catch (error) { this.runs.delete(operation.id); throw error }
    return {
      extension: { pluginId: grant.pluginId, name: grant.name },
      run: {
        ready: async ({ cwd, sessionId, validate }: { cwd: string; sessionId?: string; validate: () => Promise<string> }) => {
          operation.cwd = cwd
          operation.sessionId = sessionId
          for (;;) {
            signal.throwIfAborted()
            await check()
            const recipe = project.state.recipe
            if (!recipe) break
            await validate()
            signal.throwIfAborted()
            operation.stage = "setup"; operation.attempt++; operation.command = recipe.command
            operation.error = undefined; operation.exitCode = undefined
            await save()
            await context.authorize?.({ stage: "setup", cwd, projectCwd: project.cwd, sessionId })
            await check()
            signal.throwIfAborted()
            let commandError: string | undefined
            try {
              operation.exitCode = await runSetupCommand({ cwd, command: recipe.command, timeoutMs: recipe.timeoutMs, signal, output })
              if (operation.exitCode !== 0) commandError = `Setup command exited with code ${operation.exitCode ?? "unknown"}`
            } catch (error) {
              signal.throwIfAborted()
              commandError = error instanceof Error ? error.message : "Setup command failed"
            }
            if (!commandError) break
            operation.stage = "failed"; operation.error = commandError
            // Install the retry waiter before publishing the failed stage.
            const decision = new Promise<void>((resolve, reject) => {
              const aborted = () => { run.retry = undefined; reject(signal.reason) }
              run.retry = () => { run.retry = undefined; signal.removeEventListener("abort", aborted); resolve() }
              signal.addEventListener("abort", aborted, { once: true })
              if (signal.aborted) aborted()
            })
            void decision.catch(() => {})
            await save()
            await decision
          }
          operation.stage = "agent-start"; operation.error = undefined
          await save()
        },
        finish: async ({ stage, error }: { stage: "ready" | "cancelled" | "interrupted"; error?: string }) => {
          if (flushing) clearTimeout(flushing)
          this.runs.delete(operation.id)
          operation.stage = run.cancelled && stage === "interrupted" ? "cancelled" : stage
          if (error) operation.error = error
          await save()
        },
      },
    }
  }

  /** Stops every running recipe of a plugin that is being disabled, updated or removed; their startups end without releasing the first prompt. */
  abort(pluginId?: string): void {
    for (const run of this.runs.values()) if (!pluginId || run.pluginId === pluginId) run.controller.abort(new Error(DISABLED))
  }

  async execute(request: WorktreeSetupIntegrationRequest, caller: WorktreeSetupCaller): Promise<WorktreeSetupSnapshot | WorktreeSetupProposal | WorktreeSetupScripts> {
    assertWorktreeStartCapabilities(caller.request)
    const scope = scopeOfPrincipal(caller.principal)
    if (request.operation === "scripts") {
      const scripts = (await discoverScripts(await physicalDirectory(caller.workspacePath))).filter((script) => script.dirLabel === "root/" && /^[\w:@/.-]+$/.test(script.name)).slice(0, 100)
      await caller.authorize()
      return { scripts: scripts.map(({ name, command }) => ({ name, command: command.slice(0, 1000) })) }
    }
    if (request.operation === "propose") {
      for (const [id, proposal] of this.proposals) if (proposal.expiresAt <= Date.now()) this.proposals.delete(id)
      if (this.proposals.size >= 64) throw new RouteError(429, ErrorCodes.CONFLICT, "Too many pending setup changes")
      const workspacePath = await physicalDirectory(caller.workspacePath)
      await caller.authorize()
      const proposalId = randomUUID()
      this.proposals.set(proposalId, { pluginId: caller.pluginId, scope, workspacePath, command: request.command, timeoutMs: request.timeoutMs, expiresAt: Date.now() + PROPOSAL_TTL_MS })
      return { proposalId }
    }
    const project = await this.store.project(scope, caller.workspacePath)
    await caller.authorize()
    if (request.operation === "act") this.act(project, request.operationId, request.action)
    return publicSnapshot(project)
  }

  /** Saves a proposal the user confirmed in Cogpit's own dialog; the frame cannot reach this. */
  async confirm(proposalId: string, caller: WorktreeSetupCaller): Promise<WorktreeSetupSnapshot> {
    assertWorktreeStartCapabilities(caller.request)
    const proposal = this.proposals.get(proposalId)
    const workspacePath = await physicalDirectory(caller.workspacePath)
    if (!proposal || proposal.expiresAt <= Date.now() || proposal.pluginId !== caller.pluginId || proposal.scope !== scopeOfPrincipal(caller.principal) || proposal.workspacePath !== workspacePath) {
      throw new RouteError(409, ErrorCodes.CONFLICT, "This setup change expired or belongs to another project; review it again")
    }
    this.proposals.delete(proposalId)
    const project = await this.store.project(proposal.scope, proposal.workspacePath)
    await caller.authorize()
    await this.store.configure(project, { command: proposal.command, trusted: true, timeoutMs: proposal.timeoutMs })
    return publicSnapshot(project)
  }

  private act(project: SetupProject, id: string, action: "retry" | "cancel"): void {
    const operation = project.state.operations.find((entry) => entry.id === id)
    const run = operation && this.runs.get(id)
    if (!operation || !run || !worktreeSetupActive(operation.stage)) throw new RouteError(409, ErrorCodes.CONFLICT, "Startup is no longer active; inspect the retained worktree")
    if (action === "cancel") { run.cancelled = true; run.controller.abort(new Error("Worktree startup cancelled. Worktree retained.")) }
    else if (operation.stage === "failed" && run.retry) {
      operation.stage = "setup"
      run.retry()
    } else throw new RouteError(409, ErrorCodes.CONFLICT, "Setup is not waiting for a retry")
  }
}
