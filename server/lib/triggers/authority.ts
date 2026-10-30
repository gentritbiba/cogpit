import { randomUUID } from "node:crypto"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { isTerminalOccurrence, type ExecutionGrant, type ExecutionTarget, type GrantRef, type UnattendedAction } from "../../../shared/contracts/triggers"
import { accessAtLeast } from "../../../shared/contracts/sessionAccess"
import { accessLevelOf, editionModule, getRequestPrincipal, type UnattendedGrantRequest } from "../../edition"
import { orchestrationStore } from "../../orchestration/storage"
import { getRequestAuthentication, type RequestAuthentication } from "../../requestAuthentication"
import { OrchestrationError, type OrchestrationStore } from "../../orchestration/store"

/**
 * Durable authority for unattended work. A grant is a stored, revocable
 * record naming one account, the actions it allows and the exact target
 * they may reach; it never holds a request, a cookie or a token. Each
 * execution re-checks it: personal edition answers from the grant alone,
 * an edition that signs accounts in answers through its `unattended` hook,
 * and an edition without one holds every execution for live reauthorization.
 */

/** Whether `wanted` stays inside what `granted` names: every field the grant sets must match. */
export function targetWithin(granted: ExecutionTarget, wanted: ExecutionTarget): boolean {
  return (Object.keys(granted) as Array<keyof ExecutionTarget>).every((key) => granted[key] === undefined || granted[key] === wanted[key])
}

function grantSource(): ExecutionGrant["source"] {
  const edition = editionModule()
  if (!edition.auth) return "personal"
  return edition.unattended ? "edition" : "none"
}

/** Whether this server can run a grant's work while its owner is away; `none` holds it for live reauthorization. */
export function unattendedSupport(): ExecutionGrant["source"] { return grantSource() }

/**
 * A grant for the caller over exactly `request`. The caller must already be
 * able to do it now: a send needs interact access to its session. Where the
 * edition cannot vouch for an absent account the grant is still recorded,
 * with source `none`, so its executions are held rather than run.
 */
export async function issueExecutionGrant(req: IncomingMessage, request: UnattendedGrantRequest, scope: string): Promise<ExecutionGrant> {
  if (!request.actions.length) throw new OrchestrationError(400, "A grant must allow at least one action")
  if (request.actions.includes("session.send")) {
    if (!request.target.sessionId) throw new OrchestrationError(400, "A grant that sends must name its session")
    const level = await accessLevelOf(req, request.target.sessionId)
    if (level === null || !accessAtLeast(level, "interact")) throw new OrchestrationError(403, "Session access is required before scheduling work for it")
  }
  if (request.actions.includes("session.create") && !request.target.dirName && !request.target.cwd) throw new OrchestrationError(400, "A grant that creates sessions must name its project")
  const source = grantSource()
  const now = Date.now()
  let ref: GrantRef = { grantId: `grant-${randomUUID()}`, revision: 1 }
  if (source === "edition") {
    const issued = await editionModule().unattended!.issue(req, request)
    if (!issued) throw new OrchestrationError(403, "Your account may not run this work while you are away")
    ref = issued
  }
  const grant: ExecutionGrant = { id: ref.grantId, revision: ref.revision, scope, source, actions: [...request.actions], target: request.target, label: request.label.slice(0, 200), createdAt: now, updatedAt: now }
  if (orchestrationStore().grant(grant.id)) throw new OrchestrationError(409, "The edition issued a grant id that is already in use")
  return orchestrationStore().putGrant(grant)
}

export async function revokeExecutionGrant(grantId: string, reason: string): Promise<void> {
  const grant = orchestrationStore().revokeGrant(grantId, reason)
  if (grant?.source === "edition") await editionModule().unattended?.revoke(grantId).catch(() => {})
}

export type ResolvedExecution = { req: IncomingMessage } | { hold: string }

/**
 * The request one execution under `ref` runs as, or why it must be held.
 * Checked every time: revocation, revision, expiry, action and target, the
 * edition's own answer, and that the account it answers as is the grant's.
 */
export async function resolveExecution(ref: GrantRef, action: UnattendedAction, target: ExecutionTarget, scope?: string): Promise<ResolvedExecution> {
  const grant = orchestrationStore().grant(ref.grantId)
  if (!grant) return { hold: "This task's authorization no longer exists; reauthorize it" }
  if (grant.revokedAt) return { hold: `This task's authorization was revoked${grant.revokedReason ? `: ${grant.revokedReason}` : ""}` }
  if (grant.revision !== ref.revision) return { hold: "This task's authorization changed; reauthorize it" }
  if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) return { hold: "This task's authorization expired; reauthorize it" }
  if (scope !== undefined && grant.scope !== scope) return { hold: "This task belongs to another account" }
  if (!grant.actions.includes(action) || !targetWithin(grant.target, target)) return { hold: "This run reaches beyond what its authorization allows" }
  const source = grantSource()
  if (grant.source !== source) return { hold: "This server's sign-in changed since the task was authorized; reauthorize it" }
  if (source === "none") return { hold: "This server cannot run work while you are away; reauthorize this run" }
  if (source === "personal") return { req: new IncomingMessage(new Socket()) }
  const req = await editionModule().unattended!.resolve({ ...ref, action, target }).catch(() => null)
  if (!req) return { hold: "Your account can no longer run this task; reauthorize it" }
  if (getRequestPrincipal(req)?.userId !== grant.scope) return { hold: "The edition answered for another account" }
  return { req }
}

/**
 * Sign-ins someone reauthorized an occurrence with, for an edition that
 * cannot vouch for an absent account: memory only, so a restart holds the
 * occurrence again rather than persisting a session.
 */
const liveAuthorities = new Map<string, RequestAuthentication | null>()
const liveKey = (scope: string, occurrenceId: string) => JSON.stringify([scope, occurrenceId])

export function setLiveAuthority(scope: string, occurrenceId: string, req: IncomingMessage): void { liveAuthorities.set(liveKey(scope, occurrenceId), getRequestAuthentication(req)) }
/** The sign-in an occurrence was reauthorized with, `undefined` when none; null is a local caller's. */
export function liveAuthority(scope: string, occurrenceId: string): RequestAuthentication | null | undefined { return liveAuthorities.get(liveKey(scope, occurrenceId)) }
/** Drops the sign-ins of occurrences that settled, or no longer exist. */
export function forgetSettledLiveAuthorities(store: OrchestrationStore): void {
  for (const key of liveAuthorities.keys()) {
    const [scope, id] = JSON.parse(key) as [string, string]
    const occurrence = store.occurrence(scope, id)
    if (!occurrence || isTerminalOccurrence(occurrence.state)) liveAuthorities.delete(key)
  }
}
export function __resetLiveAuthoritiesForTest(): void { liveAuthorities.clear() }
