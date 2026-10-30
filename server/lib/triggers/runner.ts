import type { IncomingMessage } from "node:http"
import type { CommandIntent, CommandReceipt } from "../../../shared/contracts/orchestration"
import type { ExecutionTarget, OccurrenceHold, TriggerOccurrence } from "../../../shared/contracts/triggers"
import type { SendRequest, StartedSession } from "../../agents/runtimeTypes"
import type { StartupAuthorizationContext } from "../../../shared/contracts/worktreeSetup"
import { startTurn } from "../../edition"
import type { CommandDispatcher } from "../../orchestration/dispatcher"
import { orchestrationStore } from "../../orchestration/storage"
import { OrchestrationError, type ClaimedOccurrence, type DispatcherLease, type OrchestrationStore } from "../../orchestration/store"
import { admitOccurrenceCommand, attachGrantAuthorities, commandDispatcher, commandScope, executionRequestFor, refreshExecutionRequest } from "../durableSend"
import { RouteError } from "../routeError"
import { createSession, type CreateSessionInput } from "../sessionCreate"
import { assertSetupCapabilities } from "../../worktreeSetup/authorization"
import { forgetSettledLiveAuthorities, liveAuthority, resolveExecution, setLiveAuthority, type ResolvedExecution } from "./authority"

/**
 * The one scheduler: trigger occurrences run on the command dispatcher's
 * clock and lease, so a single host claims them and a crash is reconciled by
 * the same takeover that reconciles commands. Consumers register a handler
 * per kind; the runner owns authority, admission and settlement.
 */

export type PreparedExecution =
  | { action: "session.send"; target: ExecutionTarget & { sessionId: string }; request: SendRequest; intent?: CommandIntent }
  | { action: "session.create"; target: ExecutionTarget; input: Omit<CreateSessionInput, "retry"> }
export type Prepared = PreparedExecution | { skip: string } | { hold: OccurrenceHold; reason: string }

/** Whether the dispatcher a handler runs on is still the one holding the lease; check it after every await, before writing. */
export interface RecordLifetime {
  signal: AbortSignal
  current: () => boolean
}

export interface TriggerHandler {
  /**
   * Records the occurrences its definitions are due for. Runs on every tick
   * this host holds the lease; work it awaits must check `lifetime.current()`
   * before it writes.
   */
  record?(store: OrchestrationStore, lifetime: RecordLifetime): Promise<void> | void
  /** What a claimed occurrence runs, read from its definition when it runs rather than when it was recorded. */
  prepare(occurrence: TriggerOccurrence): Promise<Prepared>
}

/** What a creation runs under: the dispatcher's lifetime, a fresh authority check before setup and first input, and a mark once a runtime start began. */
export interface CreationLifecycle {
  signal: AbortSignal
  authorizeStartup: (context: StartupAuthorizationContext) => Promise<void>
  onStart: () => void
}

export interface TriggerExecutor {
  send(claim: ClaimedOccurrence, lease: DispatcherLease, prepared: Extract<PreparedExecution, { action: "session.send" }>, req: IncomingMessage, durable: boolean, dispatcher: CommandDispatcher): Promise<CommandReceipt | null>
  create(claim: ClaimedOccurrence, prepared: Extract<PreparedExecution, { action: "session.create" }>, req: IncomingMessage, lifecycle: CreationLifecycle): Promise<StartedSession>
  /** Grant resolution; replaced in tests. */
  resolve: typeof resolveExecution
}

const handlers = new Map<string, TriggerHandler>()
/** Registers the handler for occurrences of `kind`; occurrences of a kind nobody handles wait unclaimed. */
export function registerTriggerHandler(kind: string, handler: TriggerHandler): () => void {
  handlers.set(kind, handler)
  return () => { if (handlers.get(kind) === handler) handlers.delete(kind) }
}

const MAX_RETRIES = 5
function retryDelay(attempt: number): number { return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1)) }
function statusOf(error: unknown): number { return error instanceof OrchestrationError || error instanceof RouteError ? error.status : typeof error === "object" && error && "status" in error ? Number(error.status) : 0 }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "The run failed" }

export const defaultExecutor: TriggerExecutor = {
  send: (claim, lease, prepared, req, durable, dispatcher) => admitOccurrenceCommand({
    dispatcher,
    sessionId: prepared.target.sessionId,
    request: prepared.request,
    req,
    claim,
    lease,
    intent: prepared.intent ?? "queue",
    ...(durable && claim.occurrence.grant ? { executionGrant: claim.occurrence.grant } : {}),
    ...(prepared.target.bindingRevision !== undefined ? { expectedBindingRevision: prepared.target.bindingRevision } : {}),
  }),
  create: (claim, prepared, req, lifecycle) => createSession(
    {
      ...prepared.input,
      retry: { scope: claim.occurrence.scope, requestId: claim.occurrence.creationId },
      setupScope: claim.occurrence.scope,
      signal: lifecycle.signal,
      authorizeStartup: lifecycle.authorizeStartup,
    },
    (runtime, request) => {
      lifecycle.onStart()
      return startTurn(req, Date.now(), runtime, request)
    },
  ),
  resolve: resolveExecution,
}

/** Refused before a session's setup or first input; `reauthorize` when its authority is what changed. */
class StartupRefused extends Error {
  constructor(message: string, readonly reauthorize: boolean) { super(message); this.name = "StartupRefused" }
}

/** Executions in flight on any runner, so shutdown can let them stop before storage closes. */
const inFlight = new Set<Promise<void>>()
/** Resolves once every trigger execution has stopped, or after `timeoutMs`. */
export async function triggerExecutionsSettled(timeoutMs = 5_000): Promise<void> {
  if (inFlight.size === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.allSettled([...inFlight]), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })])
  clearTimeout(timer)
}

export class TriggerRunner {
  constructor(private readonly dispatcher: CommandDispatcher, private readonly executor: TriggerExecutor = defaultExecutor) {}

  /** False once the dispatcher closed or another attempt or host owns the claim: nothing further may start. */
  private live(claim: ClaimedOccurrence, lease: DispatcherLease): boolean {
    return !this.dispatcher.signal.aborted && this.store.occurrenceCurrent(claim, lease)
  }

  get store(): OrchestrationStore { return this.dispatcher.store }

  /** One scheduler pass, tracked like an execution so shutdown waits for it, and stopped at every await once the dispatcher closed. */
  async tick(lease: DispatcherLease): Promise<void> {
    const running = this.pass(lease)
    inFlight.add(running)
    try { await running } finally { inFlight.delete(running) }
  }

  private async pass(lease: DispatcherLease): Promise<void> {
    const { signal } = this.dispatcher
    const lifetime: RecordLifetime = { signal, current: () => !signal.aborted && this.store.ownsLease(lease) }
    for (const handler of handlers.values()) {
      if (!lifetime.current()) return
      await handler.record?.(this.store, lifetime)
    }
    if (!lifetime.current()) return
    this.store.settleAdmittedOccurrences()
    forgetSettledLiveAuthorities(this.store)
    await attachGrantAuthorities(this.dispatcher)
    if (!lifetime.current()) return
    for (const claim of this.store.claimOccurrences(lease, [...handlers.keys()])) {
      const running = this.execute(claim, lease).catch((error: unknown) => { console.error("[orchestration] trigger execution failed", error) })
      inFlight.add(running)
      void running.finally(() => inFlight.delete(running))
    }
  }

  /** Runs due work now rather than at the next heartbeat. */
  wake(): void { void this.dispatcher.tick() }

  /**
   * Returns a held occurrence to the schedule to run as `req`'s live sign-in,
   * admission and delivery alike: how an edition without durable grants runs
   * unattended work. Kept in memory only, so a restart holds it again.
   */
  reauthorizeLive(req: IncomingMessage, scope: string, occurrenceId: string): TriggerOccurrence {
    if (commandScope(req) !== scope || !refreshExecutionRequest(req)) throw new OrchestrationError(403, "Only the task's signed-in owner can reauthorize it")
    const occurrence = this.store.requeueOccurrence(scope, occurrenceId)
    setLiveAuthority(scope, occurrenceId, req)
    this.wake()
    return occurrence
  }

  private async authority(occurrence: TriggerOccurrence, prepared: PreparedExecution): Promise<ResolvedExecution & { durable?: boolean }> {
    const live = liveAuthority(occurrence.scope, occurrence.id)
    if (live !== undefined) {
      const fresh = executionRequestFor(live, occurrence.scope)
      if (fresh && commandScope(fresh) === occurrence.scope) return { req: fresh, durable: false }
      return { hold: "The sign-in that reauthorized this run expired; reauthorize it again" }
    }
    if (!occurrence.grant) return { hold: "This run needs to be reauthorized by its owner" }
    const resolved = await this.executor.resolve(occurrence.grant, prepared.action, prepared.target, occurrence.scope)
    return "req" in resolved ? { ...resolved, durable: true } : resolved
  }

  private async execute(claim: ClaimedOccurrence, lease: DispatcherLease): Promise<void> {
    const { occurrence } = claim
    // After the dispatcher closed, storage is left alone: the next host reconciles the claim.
    const finish = (state: Parameters<OrchestrationStore["finishOccurrence"]>[2], details?: Parameters<OrchestrationStore["finishOccurrence"]>[3]) => !this.dispatcher.signal.aborted && this.store.finishOccurrence(claim, lease, state, details)
    let prepared: Prepared
    try {
      const handler = handlers.get(occurrence.kind)
      if (!handler) { finish("scheduled"); return }
      prepared = await handler.prepare(occurrence)
    } catch (error) {
      finish("failed", { reason: messageOf(error) })
      return
    }
    if (this.dispatcher.signal.aborted) return
    if ("skip" in prepared) { finish("skipped", { reason: prepared.skip }); return }
    if ("hold" in prepared) { finish("held", { hold: prepared.hold, reason: prepared.reason }); return }
    const authority = await this.authority(occurrence, prepared).catch((error: unknown) => ({ hold: messageOf(error) }))
    if (this.dispatcher.signal.aborted) return
    if ("hold" in authority) { finish("held", { hold: "reauthorize", reason: authority.hold }); return }
    if (!this.live(claim, lease)) return
    if (prepared.action === "session.send") await this.send(claim, lease, prepared, authority.req, authority.durable === true, finish)
    else await this.create(claim, lease, prepared, authority.req, finish)
  }

  private async send(claim: ClaimedOccurrence, lease: DispatcherLease, prepared: Extract<PreparedExecution, { action: "session.send" }>, req: IncomingMessage, durable: boolean, finish: (state: TriggerOccurrence["state"], details?: { reason?: string; hold?: OccurrenceHold; dueAt?: number }) => boolean): Promise<void> {
    try {
      // Null: the store settled it instead (fenced, binding moved, lease lost).
      await this.executor.send(claim, lease, prepared, req, durable, this.dispatcher)
    } catch (error) {
      // Nothing was admitted, so a retry cannot duplicate a delivery.
      const status = statusOf(error)
      if (status === 403) finish("held", { hold: "reauthorize", reason: messageOf(error) })
      else if (status === 404 || status === 400 || status === 413) finish("failed", { reason: messageOf(error) })
      else if (status === 409) finish("held", { hold: "review", reason: messageOf(error) })
      else if (claim.attempt >= MAX_RETRIES) finish("failed", { reason: `Gave up after ${claim.attempt} attempts: ${messageOf(error)}` })
      else finish("scheduled", { reason: messageOf(error), dueAt: Date.now() + retryDelay(claim.attempt) })
    }
  }

  /**
   * The check a creation runs before its worktree setup and again before the
   * session's first input: the dispatcher still open, this attempt still the
   * claim's, and the occurrence's authority — live sign-in or current grant —
   * still allowing this target in the project the session actually starts in.
   */
  private startupCheck(claim: ClaimedOccurrence, lease: DispatcherLease, prepared: Extract<PreparedExecution, { action: "session.create" }>): (context: StartupAuthorizationContext) => Promise<void> {
    return async (context) => {
      if (!this.live(claim, lease)) throw new StartupRefused("The run stopped before its session started", false)
      const target = prepared.target.cwd !== undefined ? { ...prepared.target, cwd: context.projectCwd } : prepared.target
      const occurrence = this.store.occurrence(claim.occurrence.scope, claim.occurrence.id) ?? claim.occurrence
      const resolved = await this.authority(occurrence, { ...prepared, target })
      if ("hold" in resolved) throw new StartupRefused(resolved.hold, true)
      // A worktree start may run the project's setup commands: the interactive policy applies to the account as it stands now.
      if (prepared.input.worktreeName) {
        try { assertSetupCapabilities(resolved.req) } catch (error) { throw new StartupRefused(messageOf(error), true) }
      }
      if (!this.live(claim, lease)) throw new StartupRefused("The run stopped before its session started", false)
    }
  }

  private async create(claim: ClaimedOccurrence, lease: DispatcherLease, prepared: Extract<PreparedExecution, { action: "session.create" }>, req: IncomingMessage, finish: (state: TriggerOccurrence["state"], details?: { reason?: string; hold?: OccurrenceHold; sessionId?: string }) => boolean): Promise<void> {
    if (!this.store.beginOccurrenceCreation(claim, lease)) return
    let started = false
    try {
      const session = await this.executor.create(claim, prepared, req, {
        signal: this.dispatcher.signal,
        authorizeStartup: this.startupCheck(claim, lease, prepared),
        onStart: () => { started = true },
      })
      finish("completed", { sessionId: session.sessionId })
    } catch (error) {
      if (this.dispatcher.signal.aborted) return
      const { scope, creationId } = claim.occurrence
      // Refused before any runtime started: nothing exists, so the claim can be forgotten and run again once reauthorized.
      if (!started && this.store.occurrenceCurrent(claim, lease)) {
        this.store.abandonOperation(scope, creationId)
        if (error instanceof StartupRefused || statusOf(error) === 403) finish("held", { hold: "reauthorize", reason: messageOf(error) })
        else finish("failed", { reason: messageOf(error) })
        return
      }
      // Otherwise the creation operation, not the error, says whether a session may exist.
      const operation = this.store.operation(scope, creationId)
      const sessionId = (operation?.result as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId === "string") finish("completed", { sessionId })
      else if (operation) finish("unknown", { reason: `${messageOf(error)}. A session may have started; check the project's sessions before marking this run.` })
      else if (statusOf(error) === 403) finish("held", { hold: "reauthorize", reason: messageOf(error) })
      else finish("failed", { reason: messageOf(error) })
    }
  }
}

const runners = new WeakMap<CommandDispatcher, TriggerRunner>()
/** The runner on the current dispatcher, attached to its clock on first use. */
export function triggerScheduler(): TriggerRunner {
  const dispatcher = commandDispatcher()
  let runner = runners.get(dispatcher)
  if (!runner) {
    const created = new TriggerRunner(dispatcher)
    dispatcher.onTick((lease) => created.tick(lease))
    runners.set(dispatcher, created)
    runner = created
  }
  return runner
}

/** At boot: start the clock when stored definitions or occurrences are waiting, so a restart resumes them. */
export function startTriggerScheduler(): void {
  try {
    if (orchestrationStore().hasTriggerWork()) triggerScheduler()
  } catch (error) {
    console.error("[orchestration] could not start scheduled work", error)
  }
}
