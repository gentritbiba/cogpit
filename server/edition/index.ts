import type { IncomingMessage, ServerResponse } from "node:http"
import { accessAtLeast, type ListScope, type SessionAccessLevel } from "../../shared/contracts/sessionAccess"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import type { NextFn } from "../http"
import { getRequestPrincipal } from "../requestPrincipal"
import type { AgentRuntime, SendOutcome, SendRequest, StartedSession, StartSessionRequest } from "../agents/runtimeTypes"
import { editionModule } from "./registry"
import { sendSessionHidden } from "./refusals"
import { allVisible, annotateAll } from "./visibleInOrder"
import type {
  ActivitySessionRef,
  AuthEventData,
  AuthorizedSession,
  DataArgs,
  HandedPrompt,
  ItemVisibility,
  LineageHint,
  SendContext,
  SessionEventData,
  SessionEventSession,
  SessionIdRef,
  SessionRef,
  ShareEventData,
  ShareLogin,
  VisibilityCheck,
  VisibilityPick,
  VisibleSession,
  WithAccess,
} from "./types"

/**
 * The edition seam. Core never imports an edition: it asks the running one
 * through here, and personal edition answers every question without a check.
 * Routes import session access, ownership, activity reports and turns from
 * this module only — and the transcript checks from ./transcript, which also read
 * the agent stores this module keeps clear of.
 */

export { describeEditionSuppression, resolveEdition, type EditionShell } from "./resolve"
export { editionModule, getEdition, installEdition, __resetEditionForTest } from "./registry"
export { loadEdition, type EditionImporter } from "./load"
export { PERSONAL_EDITION } from "./personal"
export { allVisible, takeInOrder, takeVisible, visibleInOrder, type VisibleItem } from "./visibleInOrder"
export { sendSessionDenied, sendSessionHidden } from "./refusals"
export { getRequestPrincipal } from "../requestPrincipal"
export type * from "./types"

/** Mounted right after authMiddleware: what the authenticated caller may reach. */
export function editionAuthz(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  editionModule().authorize(req, res, next)
}

// ── Session access ───────────────────────────────────────────────────

/**
 * Check the caller may act on a session at `needed`. Returns what it allowed,
 * or null after answering 404 (no access, or no such session) or 403 (too
 * little access): `=== null` is the only refusal check. `hint` is lineage the
 * server read, never request input. Marks the request decided.
 */
export function authorizeSession(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SessionRef,
  needed: SessionAccessLevel,
  hint?: LineageHint,
): Promise<AuthorizedSession | null> {
  return editionModule().access.authorizeSession(req, res, ref, needed, hint)
}

/**
 * `authorizeSession` at `view` for a stream whose path does not name its
 * session — an agent team watch checks the lead it read from the team's config, task
 * output the session whose task directory holds the file. It binds the stream only on a path
 * `isAuthenticatedHttpStreamRequest` (security.ts) counts as a stream; any
 * other response is checked once and never re-checked. Call it before the
 * stream's headers: after them a refusal has no answer.
 */
export function authorizeStreamSession(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SessionIdRef,
): Promise<AuthorizedSession | null> {
  if (res.headersSent) throw new Error("A stream's session must be authorized before its headers are sent")
  return authorizeSession(req, res, ref, "view")
}

/** The caller's level on a session `authorizeSession` let them see; null when they have none after all. */
export function accessLevelOf(req: IncomingMessage, sessionId: string): Promise<SessionAccessLevel | null> {
  return editionModule().access.levelOf(req, sessionId)
}

/** A predicate for pipelines that must filter before they limit, page or count. Marks the request decided. */
export function visibilityFor(req: IncomingMessage, scope?: ListScope): VisibilityCheck {
  return editionModule().access.visibilityFor(req, scope)
}

/** The visible items, in order, each with its `access` where the edition checks access. Marks the request decided. */
export async function filterVisible<T extends object>(
  req: IncomingMessage,
  items: readonly T[],
  pick: (item: T) => VisibilityPick,
  scope?: ListScope,
): Promise<Array<WithAccess<T>>> {
  return annotateAll(await allVisible(items, visibilityFor(req, scope), pick))
}

/** A request's `scope` parameter: "all" unless it names another the caller may use. */
export function parseScope(req: IncomingMessage, value: unknown): ListScope {
  return editionModule().access.parseScope(req, value)
}

/**
 * Whether named accounts sign in to this server in place of the network
 * password: the edition authenticates every request, a local one included.
 */
export function editionOwnsSignIn(): boolean {
  return editionModule().auth !== null
}

/**
 * Whether the caller may act on what no session owns — host-wide items in a
 * list, project-wide session defaults. Personal edition's one trusted owner
 * may; where the edition signs accounts in, it decides for the caller's.
 */
export function mayActHostWide(req: IncomingMessage): boolean {
  const auth = editionModule().auth
  if (!auth) return true
  const principal = getRequestPrincipal(req)
  return principal !== null && auth.administers(principal)
}

/**
 * A predicate for lists that mix session items with host-wide ones no session
 * owns (a notification about the host): a session item is shown to whoever
 * holds at least the level it names on its session (view by default), a
 * host-wide one (`null`) to whoever may act host-wide. Each session is
 * checked once, however many items name it. Marks the request decided.
 */
export function itemVisibilityFor(req: IncomingMessage): ItemVisibility {
  const sessionVisible = visibilityFor(req)
  const hostWide = mayActHostWide(req)
  const levels = new Map<string, Promise<SessionAccessLevel | null>>()
  return async (sessionId, needed = "view") => {
    if (sessionId === null) return hostWide
    let level = levels.get(sessionId)
    if (!level) {
      level = sessionVisible(sessionId).then(heldLevel)
      levels.set(sessionId, level)
    }
    const held = await level
    return held !== null && accessAtLeast(held, needed)
  }
}

/** The caller's level on a session they may see; null when they may not. Personal edition annotates none: its one caller owns everything. */
async function heldLevel(session: VisibleSession | "hidden"): Promise<SessionAccessLevel | null> {
  if (session === "hidden") return null
  const annotated = await session.annotate({})
  return annotated && (annotated.access?.level ?? "own")
}

/**
 * For an item no session owns, such as an agent team whose config names no
 * lead: whoever may act host-wide may act on it, and anyone else is
 * answered as for a session they cannot see. False after answering. Marks the
 * request decided.
 */
export function authorizeHostWide(req: IncomingMessage, res: ServerResponse): boolean {
  markDecided(req)
  if (mayActHostWide(req)) return true
  sendSessionHidden(res, null)
  return false
}

/** For a response that reads no session under a rule that is not `sessionFree`. */
export function markDecided(req: IncomingMessage): void {
  editionModule().access.markDecided(req)
}

/** The caller owns the session they just created or branched. Never throws. */
export function recordSessionOwner(req: IncomingMessage, sessionId: string, agent: AgentKind): void {
  editionModule().access.recordSessionOwner(req, sessionId, agent)
}

/** Forget a deleted session's owner, grants and links. Resolves for any id, even one that names no session. */
export function removeSessionAccess(sessionId: string): Promise<void> {
  return editionModule().access.removeSessionAccess(sessionId)
}

/**
 * An agent team a route just read. Its members name only the team, and the
 * team's config — the one place naming its lead — goes when the team is
 * deleted, so an edition that checks access places them under the lead while
 * it can. Runs in the background.
 */
export function observeAgentTeam(teamName: string): void {
  void editionModule().access.observeAgentTeam(teamName)
}

/** Tell the session's open streams its stored config changed, where the edition streams it. Never throws. */
export function announceSessionConfig(sessionId: string): void {
  editionModule().access.announceSessionConfig(sessionId)
}

// ── Browser profiles ─────────────────────────────────────────────────

/**
 * The managed browser profile a session's agent opens as `default`, or null
 * for the host's own. Null `sessionId` asks for an agent Cogpit cannot tie to
 * a session.
 */
export function sessionBrowserProfile(sessionId: string | null): string | null {
  return editionModule().browsers.profileForSession(sessionId)
}

/** The caller's own browser profile, or null when theirs is the host's `default`. */
export function callerBrowserProfile(req: IncomingMessage): string | null {
  return editionModule().browsers.profileForCaller(req)
}

/** A browser name the edition hands out, which nobody may create by hand. */
export function reservesBrowserName(name: string): boolean {
  return editionModule().browsers.reservesName(name)
}

/** The display name of the account whose own browser profile `name` is. */
export function browserAccountOf(name: string): string | null {
  return editionModule().browsers.accountOf(name)
}

// ── Activity ─────────────────────────────────────────────────────────

export function reportSessionEvent<A extends keyof SessionEventData>(
  req: IncomingMessage,
  action: A,
  session: SessionEventSession<A>,
  ...data: DataArgs<SessionEventData[A]>
): void {
  editionModule().activity.reportSessionEvent(req, action, session, ...data)
}

export function reportAuthEvent<A extends keyof AuthEventData>(
  req: IncomingMessage,
  action: A,
  ...data: DataArgs<AuthEventData[A]>
): void {
  editionModule().activity.reportAuthEvent(req, action, ...data)
}

export function reportShareEvent<A extends keyof ShareEventData>(
  req: IncomingMessage,
  action: A,
  session: ActivitySessionRef,
  ...data: DataArgs<ShareEventData[A]>
): void {
  editionModule().activity.reportShareEvent(req, action, session, ...data)
}

/** A guest's sign-in to a share, reported as that guest. */
export function reportShareLogin(req: IncomingMessage, login: ShareLogin): void {
  editionModule().activity.reportShareLogin(req, login)
}

// ── Turns ────────────────────────────────────────────────────────────

/** Start a session with its first prompt on the caller's behalf. */
export function startTurn(
  req: IncomingMessage,
  receivedAt: number,
  runtime: AgentRuntime,
  request: StartSessionRequest,
): Promise<StartedSession> {
  return editionModule().turns.start(req, receivedAt, runtime, request)
}

/** Send a message to a session on the caller's behalf. */
export function sendTurn(
  req: IncomingMessage,
  runtime: AgentRuntime,
  sessionId: string,
  request: SendRequest,
  context: SendContext,
): Promise<SendOutcome> {
  return editionModule().turns.send(req, runtime, sessionId, request, context)
}

/** Hand the agent a prompt through `deliver` on the caller's behalf; `delivered` is how the agent took it once `deliver` resolves. */
export function handPrompt<T>(
  req: IncomingMessage,
  prompt: HandedPrompt,
  deliver: () => Promise<T>,
  delivered: SendOutcome["delivery"],
): Promise<T> {
  return editionModule().turns.hand(req, prompt, deliver, delivered)
}
