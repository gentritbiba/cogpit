import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import type { IncomingHttpHeaders, IncomingMessage } from "node:http"
import { isAbsolute } from "node:path"
import { AUTOMATION_KIND, AUTOMATION_LIMITS, type AutomationDefinition, type AutomationRun, type AutomationTask, type SaveAutomationResponse } from "../../shared/contracts/automations"
import type { ExecutionTarget, TriggerOccurrence, TriggerRecord } from "../../shared/contracts/triggers"
import { AGENT_KINDS, agentKindForDirName } from "../../shared/session/agent-descriptors"
import { runtimeFor } from "../agents/runtimes"
import { editionModule } from "../edition"
import { commandScope } from "../lib/durableSend"
import { sessionFolderProblem } from "../lib/folders"
import { issueExecutionGrant, revokeExecutionGrant, unattendedSupport } from "../lib/triggers/authority"
import { triggerScheduler } from "../lib/triggers/runner"
import { orchestrationStore } from "../orchestration/storage"
import { OrchestrationError, type OrchestrationStore } from "../orchestration/store"
import { nextDue, scheduleProblem } from "./schedule"
import { newWebhookSecret, verifyDelivery } from "./webhook"

/** What a task stores beyond its definition. */
export interface StoredAutomation extends AutomationDefinition {
  /** When interval counting started: the save that set the schedule. */
  anchor: number
}

/** A rotated secret keeps working this long, so deliveries already signed with it still land. */
const SECRET_GRACE_MS = 24 * 60 * 60_000

function bad(message: string): OrchestrationError { return new OrchestrationError(400, message) }

/** The definition as it will be stored, or why it cannot be. Resolves the project folder to its physical path. */
export async function checkDefinition(definition: AutomationDefinition): Promise<AutomationDefinition> {
  const name = definition.name?.trim()
  const prompt = definition.prompt?.trim()
  if (!name || name.length > AUTOMATION_LIMITS.nameChars) throw bad(`Name the task in 1–${AUTOMATION_LIMITS.nameChars} characters`)
  if (!prompt || prompt.length > AUTOMATION_LIMITS.promptChars) throw bad(`Write the task's prompt in 1–${AUTOMATION_LIMITS.promptChars.toLocaleString("en-US")} characters`)
  const { project, provider } = definition
  if (!project?.dirName || !project.cwd || !isAbsolute(project.cwd)) throw bad("Choose a project")
  const missing = await sessionFolderProblem(project.cwd)
  if (missing) throw bad(missing)
  if (!AGENT_KINDS.includes(provider?.agent)) throw bad("Choose a provider")
  if (agentKindForDirName(project.dirName) !== provider.agent) throw bad("The project folder belongs to another provider")
  if (provider.instanceId !== "default" && !orchestrationStore().instances().some((instance) => instance.id === provider.instanceId && instance.agent === provider.agent && !instance.retired)) throw bad("That provider account is not available")
  if (definition.workspace !== "project" && definition.workspace !== "worktree") throw bad("Choose where runs work")
  if (definition.workspace === "worktree" && !runtimeFor(provider.agent, provider.instanceId).descriptor.capabilities.worktrees) throw bad("This provider cannot start sessions in a worktree")
  const problem = definition.schedule && scheduleProblem(definition.schedule)
  if (problem) throw bad(problem)
  const webhook = definition.webhook
  if (webhook && (!["cogpit", "github"].includes(webhook.scheme) || !Number.isInteger(webhook.coalesceSeconds) || webhook.coalesceSeconds < 0 || webhook.coalesceSeconds > AUTOMATION_LIMITS.maxCoalesceSeconds)) throw bad(`Coalesce deliveries for 0–${AUTOMATION_LIMITS.maxCoalesceSeconds} seconds`)
  if (!["skip", "run-once"].includes(definition.missed) || !["skip", "allow"].includes(definition.overlap)) throw bad("Choose how missed and overlapping runs behave")
  return { ...definition, name, prompt, project: { dirName: project.dirName, cwd: await realpath(project.cwd).catch(() => project.cwd) } }
}

/** Exactly what a task's grant lets its runs reach. */
export function automationTarget(definition: AutomationDefinition): ExecutionTarget {
  return { agent: definition.provider.agent, instanceId: definition.provider.instanceId, dirName: definition.project.dirName, cwd: definition.project.cwd, workspace: definition.workspace }
}

function sameTarget(a: AutomationDefinition, b: AutomationDefinition): boolean {
  return JSON.stringify(automationTarget(a)) === JSON.stringify(automationTarget(b))
}

function scheduleDue(definition: StoredAutomation, now: number): number | null {
  return definition.schedule ? nextDue(definition.schedule, now, definition.anchor) : null
}

/** The webhook URL, and how far the server knows it reaches: a public URL only when one is configured. */
function webhookAddress(id: string, origin: string): Pick<AutomationTask, "webhookUrl" | "webhookReachability"> {
  const auth = editionModule().auth
  if (auth && auth.signedWebhookIngress !== true) return { webhookUrl: null, webhookReachability: "unavailable" }
  const publicUrl = process.env.COGPIT_PUBLIC_URL?.replace(/\/+$/, "")
  return { webhookUrl: `${publicUrl ?? origin}/api/automation-hooks/${id}`, webhookReachability: publicUrl ? "public" : "local-only" }
}

export function taskView(record: TriggerRecord, origin: string, store = orchestrationStore()): AutomationTask {
  const { anchor: _anchor, ...definition } = record.data as unknown as StoredAutomation
  const grant = record.grant && store.grant(record.grant.grantId)
  return {
    ...definition,
    id: record.id,
    revision: record.revision,
    state: record.state,
    nextRunAt: record.state === "active" ? record.nextDueAt : null,
    authority: grant ? { source: grant.source, revoked: Boolean(grant.revokedAt) } : null,
    ...(definition.webhook?.enabled ? webhookAddress(record.id, origin) : { webhookUrl: null, webhookReachability: "unavailable" as const }),
    webhookSecrets: store.triggerSecrets(record.scope, record.id).map((secret) => ({ id: secret.id, createdAt: secret.createdAt })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function sessionFile(store: OrchestrationStore, occurrence: TriggerOccurrence): { dirName?: string; fileName?: string } {
  const result = store.operation(occurrence.scope, occurrence.creationId)?.result as { dirName?: unknown; fileName?: unknown } | undefined
  return { ...(typeof result?.dirName === "string" ? { dirName: result.dirName } : {}), ...(typeof result?.fileName === "string" ? { fileName: result.fileName } : {}) }
}

/** Whether a run's session still works; its creation finishing is not the run finishing. */
function working(definition: AutomationDefinition, sessionId: string): boolean {
  try { return runtimeFor(definition.provider.agent, definition.provider.instanceId).activity(sessionId).running } catch { return false }
}

export function runView(occurrence: TriggerOccurrence, definition: AutomationDefinition, store = orchestrationStore()): AutomationRun {
  const source = (occurrence.request as { source?: AutomationRun["trigger"] }).source ?? "schedule"
  return {
    id: occurrence.id,
    trigger: source,
    state: occurrence.state,
    ...(occurrence.hold ? { hold: occurrence.hold } : {}),
    ...(occurrence.reason ? { reason: occurrence.reason } : {}),
    dueAt: occurrence.dueAt,
    createdAt: occurrence.createdAt,
    ...(occurrence.finishedAt ? { finishedAt: occurrence.finishedAt } : {}),
    deliveries: occurrence.inputs.length,
    ...(occurrence.sessionId ? { session: { sessionId: occurrence.sessionId, ...sessionFile(store, occurrence), working: working(definition, occurrence.sessionId) } } : {}),
  }
}

function owned(req: IncomingMessage, id: string): { scope: string; record: TriggerRecord; definition: StoredAutomation } {
  const scope = commandScope(req)
  const record = orchestrationStore().trigger(scope, id)
  if (!record || record.kind !== AUTOMATION_KIND) throw new OrchestrationError(404, "Task not found")
  return { scope, record, definition: record.data as unknown as StoredAutomation }
}

async function grantFor(req: IncomingMessage, scope: string, definition: AutomationDefinition) {
  const grant = await issueExecutionGrant(req, { actions: ["session.create"], target: automationTarget(definition), label: `Automation: ${definition.name}` }, scope)
  return { grantId: grant.id, revision: grant.revision }
}

function addSecret(store: OrchestrationStore, scope: string, id: string): string {
  const secret = newWebhookSecret()
  const secretId = `sec-${randomUUID()}`
  store.putTriggerSecret(scope, id, secretId, { key: secret })
  store.retireTriggerSecrets(scope, id, secretId, SECRET_GRACE_MS)
  return secret
}

export function listTasks(req: IncomingMessage, origin: string): AutomationTask[] {
  return orchestrationStore().triggers(commandScope(req), AUTOMATION_KIND).map((record) => taskView(record, origin))
}

export async function createTask(req: IncomingMessage, input: AutomationDefinition, state: "active" | "paused", origin: string): Promise<SaveAutomationResponse> {
  const scope = commandScope(req)
  const definition = await checkDefinition(input)
  const store = orchestrationStore()
  const id = `auto-${randomUUID()}`
  const now = Date.now()
  const stored: StoredAutomation = { ...definition, anchor: now }
  const record = store.putTrigger(scope, { id, kind: AUTOMATION_KIND, state, grant: await grantFor(req, scope, definition), nextDueAt: scheduleDue(stored, now), data: stored as unknown as Record<string, unknown> })
  const webhookSecret = definition.webhook?.enabled ? addSecret(store, scope, id) : undefined
  if (state === "active") triggerScheduler()
  return { task: taskView(store.trigger(scope, record.id)!, origin), ...(webhookSecret ? { webhookSecret } : {}) }
}

/**
 * Saves a new definition over a task. A different project, provider or
 * workspace needs a new grant, revokes the old one and cancels runs still
 * waiting under it; a newly enabled webhook gets its first secret.
 */
export async function updateTask(req: IncomingMessage, id: string, input: AutomationDefinition, state: "active" | "paused", expectedRevision: number, origin: string): Promise<SaveAutomationResponse> {
  const { scope, record, definition: old } = owned(req, id)
  const definition = await checkDefinition(input)
  const store = orchestrationStore()
  const now = Date.now()
  const rescheduled = JSON.stringify(definition.schedule) !== JSON.stringify(old.schedule)
  const stored: StoredAutomation = { ...definition, anchor: rescheduled ? now : old.anchor }
  let grant = record.grant
  const retarget = !sameTarget(definition, old) || !grant
  if (retarget) grant = await grantFor(req, scope, definition)
  const resumed = state === "active" && record.state === "paused"
  store.putTrigger(scope, { id, kind: AUTOMATION_KIND, state, grant, nextDueAt: rescheduled || resumed ? scheduleDue(stored, now) : record.nextDueAt, data: stored as unknown as Record<string, unknown> }, expectedRevision)
  if (retarget && record.grant) {
    for (const run of store.openOccurrences(scope, id)) if (run.state === "scheduled" || run.state === "held") store.cancelOccurrence(scope, run.id, "The task changed where it runs; this run was replaced")
    await revokeExecutionGrant(record.grant.grantId, "Its task changed where it runs")
  }
  const webhookSecret = definition.webhook?.enabled && !old.webhook?.enabled && store.triggerSecrets(scope, id).length === 0 ? addSecret(store, scope, id) : undefined
  if (state === "active") triggerScheduler()
  return { task: taskView(store.trigger(scope, id)!, origin), ...(webhookSecret ? { webhookSecret } : {}) }
}

/** Pausing keeps the task and its grant; resuming counts the schedule from now, never running the paused slots. */
export function setTaskState(req: IncomingMessage, id: string, state: "active" | "paused", origin: string): AutomationTask {
  const { scope, record, definition } = owned(req, id)
  const store = orchestrationStore()
  store.putTrigger(scope, { id, kind: AUTOMATION_KIND, state, grant: record.grant, nextDueAt: state === "active" ? scheduleDue(definition, Date.now()) : record.nextDueAt, data: record.data }, record.revision)
  if (state === "active") triggerScheduler()
  return taskView(store.trigger(scope, id)!, origin)
}

export function deleteTask(req: IncomingMessage, id: string): void {
  const { scope } = owned(req, id)
  orchestrationStore().deleteTrigger(scope, id)
}

export function rotateSecret(req: IncomingMessage, id: string): string {
  const { scope, definition } = owned(req, id)
  if (!definition.webhook?.enabled) throw bad("This task has no webhook")
  return addSecret(orchestrationStore(), scope, id)
}

export function runNow(req: IncomingMessage, id: string): AutomationRun {
  const { scope, record, definition } = owned(req, id)
  const { occurrence } = orchestrationStore().recordOccurrence(scope, { triggerId: id, kind: AUTOMATION_KIND, key: `manual:${randomUUID()}`, dueAt: Date.now(), action: "session.create", grant: record.grant, request: { source: "manual" } })
  triggerScheduler().wake()
  return runView(occurrence, definition)
}

export function listRuns(req: IncomingMessage, id: string, before?: number): AutomationRun[] {
  const { scope, definition } = owned(req, id)
  const store = orchestrationStore()
  return store.occurrences(scope, id, { before, limit: 50 }).map((occurrence) => runView(occurrence, definition, store))
}

export type RunAction = "cancel" | "reauthorize" | "mark-started" | "mark-not-started"

export async function actOnRun(req: IncomingMessage, id: string, runId: string, action: RunAction): Promise<AutomationRun> {
  const { scope, record, definition } = owned(req, id)
  const store = orchestrationStore()
  const run = store.occurrence(scope, runId)
  if (!run || run.triggerId !== id) throw new OrchestrationError(404, "Run not found")
  let next: TriggerOccurrence
  if (action === "cancel") next = store.cancelOccurrence(scope, runId, "Cancelled by its owner")
  else if (action === "mark-started" || action === "mark-not-started") next = store.resolveOccurrence(scope, runId, action === "mark-started" ? "completed" : "failed")
  else {
    // A grant this edition can keep is renewed for the task; otherwise the owner's live sign-in runs it once.
    if (unattendedSupport() === "none") {
      next = triggerScheduler().reauthorizeLive(req, scope, runId)
    } else {
      const grant = await grantFor(req, scope, definition)
      next = store.requeueOccurrence(scope, runId, grant)
      store.putTrigger(scope, { id, kind: AUTOMATION_KIND, state: record.state, grant, nextDueAt: record.nextDueAt, data: record.data }, record.revision)
      if (record.grant && record.grant.grantId !== grant.grantId) await revokeExecutionGrant(record.grant.grantId, "Replaced by reauthorization")
      triggerScheduler().wake()
    }
  }
  return runView(next, definition, store)
}

export type IngestResult = { status: number; body: Record<string, unknown> }

/**
 * A webhook delivery: authenticated by its task's secret, deduplicated by
 * delivery id, and folded with the deliveries of the same burst into one
 * run. Its body is kept as untrusted text for the run's prompt.
 */
export function ingestDelivery(id: string, headers: IncomingHttpHeaders, body: Buffer, now = Date.now()): IngestResult {
  const store = orchestrationStore()
  const record = store.triggers(null, AUTOMATION_KIND).find((candidate) => candidate.id === id)
  const definition = record?.data as unknown as StoredAutomation | undefined
  // An unknown task, or one without a webhook, answers like a bad signature: ids are not secrets to probe.
  if (!record || !definition?.webhook?.enabled) return { status: 401, body: { error: "The signature does not match" } }
  const secrets = store.triggerSecrets(record.scope, id).map((secret) => String(secret.data.key))
  const verified = verifyDelivery(definition.webhook.scheme, headers, body, secrets, now)
  if (!verified.ok) return { status: verified.status, body: { error: verified.error } }
  if (record.state !== "active") return { status: 409, body: { error: "The task is paused" } }
  const window = definition.webhook.coalesceSeconds * 1000
  try {
    const { occurrence, outcome } = store.recordOccurrence(record.scope, {
      triggerId: id, kind: AUTOMATION_KIND, key: `webhook:${verified.deliveryId}`, dueAt: now + window, action: "session.create", grant: record.grant,
      request: { source: "webhook" },
      input: { data: { deliveryId: verified.deliveryId, contentType: String(headers["content-type"] ?? ""), body: body.toString("utf8") } },
      ...(window > 0 ? { coalesce: { windowMs: window, maxInputs: AUTOMATION_LIMITS.deliveriesPerRun } } : {}),
    })
    triggerScheduler()
    return { status: outcome === "duplicate" ? 200 : 202, body: { accepted: true, outcome, run: occurrence.id } }
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 500
    return { status, body: { error: error instanceof Error ? error.message : "The delivery could not be recorded" } }
  }
}
