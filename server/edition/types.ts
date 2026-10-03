import type { IncomingMessage, ServerResponse } from "node:http"
import type { NetworkInterfaceInfo } from "node:os"
import type { CogpitEdition, MeResponse } from "../../shared/contracts/identity"
import type { ListedAccess, ListScope, SessionAccessLevel } from "../../shared/contracts/sessionAccess"
import type { SessionSettingField } from "../../shared/contracts/sessionSettings"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import type { TrustedLineage } from "../agents/lineage"
import type {
  AgentRuntime,
  AgentTurnSettings,
  SendOutcome,
  SendRequest,
  StartedSession,
  StartSessionRequest,
} from "../agents/runtimeTypes"
import type { NextFn, UseFn } from "../http"
import type { SessionConfigUpdate } from "../lib/sessionConfigStore"
import type { SessionPrincipal } from "../sessionConstants"

// ── Session access ───────────────────────────────────────────────────

/**
 * A session by id. `readByServer` marks one the server read for itself, such
 * as an agent team's lead from the team's config, rather than one the request spelled:
 * a refusal never names it to a caller who cannot see it.
 */
export interface SessionIdRef {
  sessionId: string
  readByServer?: true
}

/** How a request names a session: its id, or the transcript address the UI uses. */
export type SessionRef = SessionIdRef | { dirName: string; fileName: string }

/**
 * Lineage the server read for a session (`lineageFromMeta`), never request
 * input: an edition that checks access may make the parent it names permanent
 * inheritance.
 */
export type LineageHint = TrustedLineage

/**
 * What `authorizeSession` allowed. An edition that checks access answers with
 * the lowercased top-level session as `sessionId`, and `filePath` is the transcript a
 * `{dirName, fileName}` ref resolved to — the file whose session was checked,
 * so a handler serves exactly that file rather than resolving the ref again.
 * Null for a bare id. Personal edition checks nothing: `sessionId` is what the
 * ref spells and `filePath` is null.
 */
export interface AuthorizedSession {
  sessionId: string
  filePath: string | null
  /**
   * False when the ref named a transcript filed under the session — a
   * sub-agent's or a workflow's — rather than the session's own. An edition
   * that checks access reads it from where the file really lives; personal
   * edition from its name.
   */
  isRootTranscript: boolean
}

/** A list item as a response carries it where the edition checks access. */
export type WithAccess<T> = T & { access?: ListedAccess }

/** A session the caller may see. */
export interface VisibleSession {
  /**
   * The item with the caller's `access` attached where the edition checks
   * access (unchanged in personal edition); null when the caller lost access since the check.
   */
  annotate<T extends object>(item: T): Promise<WithAccess<T> | null>
}

export interface VisibilityCheck {
  (sessionId: string, hint?: LineageHint): Promise<VisibleSession | "hidden">
  /** Every session passes (personal edition, an unrestricted caller's "all"), so a count need not check them one by one. */
  readonly everything: boolean
  /** No session passes (a caller who holds none), so a list need not read a single one. */
  readonly nothing: boolean
}

/** Whether the caller may see an item about a session, holding at least `needed` (default view) on it, or a host-wide one (`null`). */
export type ItemVisibility = (sessionId: string | null, needed?: SessionAccessLevel) => Promise<boolean>

/** The session a list item names, with any lineage the server read for it. */
export interface VisibilityPick {
  sessionId: string
  hint?: LineageHint
}

export interface EditionSessionAccess {
  authorizeSession(
    req: IncomingMessage,
    res: ServerResponse,
    ref: SessionRef,
    needed: SessionAccessLevel,
    hint?: LineageHint,
  ): Promise<AuthorizedSession | null>
  /** The caller's level on a session `authorizeSession` let them see; null when they have none after all. */
  levelOf(req: IncomingMessage, sessionId: string): Promise<SessionAccessLevel | null>
  visibilityFor(req: IncomingMessage, scope?: ListScope): VisibilityCheck
  parseScope(req: IncomingMessage, value: unknown): ListScope
  markDecided(req: IncomingMessage): void
  recordSessionOwner(req: IncomingMessage, sessionId: string, agent: AgentKind): void
  removeSessionAccess(sessionId: string): Promise<void>
  /** An agent team a route read, by name. Never rejects. */
  observeAgentTeam(teamName: string): Promise<void>
  /** Tell the session's open streams its stored config changed. Never throws. */
  announceSessionConfig(sessionId: string): void
}

// ── Activity ─────────────────────────────────────────────────────────

export type ActivityData = Record<string, unknown>
/** A reporter's data argument: optional when the action's data may be undefined. */
export type DataArgs<T> = undefined extends T ? [data?: T] : [data: T]

/** The session an event concerns, with its agent as the caller resolved it or as its project dirName names it. */
export type ActivitySessionRef =
  | { sessionId: string; agent: AgentKind; dirName?: string }
  | { sessionId: string; dirName: string }

/**
 * `answer`: an answer to a question that the agent reads as its next message.
 * `goal`: a thread goal's objective, which drives the turns it starts.
 */
export type PromptRoute = "create-and-send" | "send-message" | "steer" | "team-message" | "answer" | "goal"

export interface SessionEventData {
  /** `unconfirmed`: the agent never reported which session it created, so the event names none. */
  "session.create": { promptId: string; failed?: boolean; reason?: "unconfirmed" }
  "session.branch": { branchedFrom: string }
  /** A form's answer carries its fields as `content`, as the caller gave them; they may hold a secret. */
  "session.answer": ActivityData | undefined
  "session.permission": ActivityData | undefined
  /** A change to the session's stored settings: each field it moved, from and to its value (null for none). */
  "session.config": { changes: Record<string, { from: unknown; to: unknown }> }
  "session.stop": ActivityData | undefined
  "session.interrupt": ActivityData | undefined
  /** A goal's status or budget changed, or the goal was cleared; a new objective is handed over as a prompt. */
  "session.goal": { status?: string; tokenBudget?: number | null } | { cleared: true }
  /** Archiving is one request over many sessions, so the event names them here rather than in its session. */
  "session.archive": { sessionIds: string[]; archived: boolean }
  "session.delete": ActivityData | undefined
}

/**
 * The session an event concerns. An event over many sessions names none, since
 * its data names them, and so does a create whose session the agent never
 * confirmed.
 */
export type SessionEventSession<A extends keyof SessionEventData> =
  SessionEventData[A] extends { sessionIds: string[] } ? null
    : A extends "session.create" ? ActivitySessionRef | null
      : ActivitySessionRef

/**
 * What core routes report that concerns no session: signing out, settings and
 * folders made on the host. An edition reports its own sign-in events.
 */
export interface AuthEventData {
  "auth.logout": ActivityData | undefined
  /** The names of the settings a save changed, never their values. */
  "config.change": { keys: string[] }
  /** A folder the folder browser made. */
  "folder.create": { path: string }
}

/** What core's share routes report of a session's share link, whose passphrase is never reported. */
export interface ShareEventData {
  /** A link made, replacing any the session had. */
  "access.share": undefined
  /** The link's passphrase replaced. */
  "access.share_rotate": undefined
  "access.share_remove": undefined
}

/** Why a guest's sign-in to a share was refused. */
export type ShareLoginFailure = "not_shared" | "bad_passphrase" | "share_changed"

/** A guest's sign-in: the shared session it opened, or the session it named and why it was refused. */
export type ShareLogin = { session: ActivitySessionRef } | { sessionId: string; failure: ShareLoginFailure }

/** What core reports as it happens. Every reporter returns at once and never throws; the request goes through either way. */
export interface EditionActivity {
  reportSessionEvent<A extends keyof SessionEventData>(
    req: IncomingMessage,
    action: A,
    session: SessionEventSession<A>,
    ...[data]: DataArgs<SessionEventData[A]>
  ): void
  reportAuthEvent<A extends keyof AuthEventData>(
    req: IncomingMessage,
    action: A,
    ...[data]: DataArgs<AuthEventData[A]>
  ): void
  reportShareEvent<A extends keyof ShareEventData>(
    req: IncomingMessage,
    action: A,
    session: ActivitySessionRef,
    ...[data]: DataArgs<ShareEventData[A]>
  ): void
  /** Reported as the guest signing in, whom the request does not name yet. */
  reportShareLogin(req: IncomingMessage, login: ShareLogin): void
}

// ── Turns ────────────────────────────────────────────────────────────

/** A send as its route took it: when the request's body arrived, which route sent it, and the session access was checked on. */
export interface SendContext {
  /**
   * Read before anything else was awaited. Never earlier: a turn that ends
   * while a large body uploads is not the one this send starts.
   */
  receivedAt: number
  route: PromptRoute
  session: ActivitySessionRef
  /** The question an `answer` send answers, as `session.answer` names it. */
  toolUseId?: string
}

/** An item a prompt hands the agent besides its text: an image, a file, a skill. */
export interface PromptItem {
  readonly type: string
  readonly [field: string]: unknown
}

/** A prompt handed to the agent some other way than a send: a steer, a goal's objective, a message to an agent team member. */
export interface HandedPrompt {
  receivedAt: number
  route: PromptRoute
  /** Null when no session was checked for it, such as a message to an agent team without a lead. */
  session: ActivitySessionRef | null
  input: string | readonly PromptItem[]
  /** The agent team member whose inbox a message was written to. */
  recipient?: string
}

/**
 * How a turn reaches the agent on the caller's behalf. Personal edition hands
 * each straight over; an edition may account for the prompt around it, and may
 * refuse what it cannot account for.
 */
export interface EditionTurns {
  /** Start a session with its first prompt; the caller owns the session the agent reports. */
  start(req: IncomingMessage, receivedAt: number, runtime: AgentRuntime, request: StartSessionRequest): Promise<StartedSession>
  send(req: IncomingMessage, runtime: AgentRuntime, sessionId: string, request: SendRequest, context: SendContext): Promise<SendOutcome>
  /** Run `deliver`, which hands the agent `prompt` and resolves once it took it as `delivered`. */
  hand<T>(req: IncomingMessage, prompt: HandedPrompt, deliver: () => Promise<T>, delivered: SendOutcome["delivery"]): Promise<T>
}

// ── Policies ─────────────────────────────────────────────────────────

/**
 * What a session's stored config means for the turns it runs. Core writes and
 * reads the store, and gives a send without a permission mode the stored one;
 * personal edition leaves the rest as it came.
 */
export interface EditionSessionSettings {
  /** The settings a send runs with, once `changes` (the fields it names as new) were taken into account. */
  settleTurn<T extends AgentTurnSettings>(
    req: IncomingMessage,
    session: ActivitySessionRef,
    request: T,
    changes: readonly SessionSettingField[],
  ): Promise<T>
  /** The part of a live settings update a running session applies. */
  holdLiveUpdate<T extends object>(updates: T, changes: readonly SessionSettingField[]): T
  /** A settings change applied to a running session outside a send. */
  storeApplied(req: IncomingMessage, sessionId: string, agent: AgentKind | null, applied: AgentTurnSettings): Promise<void>
  /** A write to a session's own stored config through `PUT /api/session-config`, after it landed. */
  onConfigWrite(req: IncomingMessage, sessionId: string, update: SessionConfigUpdate): Promise<void>
}

/** How much notification history the server keeps, and how long a write waits to gather later changes. */
export interface NotificationRetention {
  /** Entries kept for the host, apart from those meant for one reader alone. */
  hostEntries: number
  persistDelayMs: number
}

// ── Authentication ───────────────────────────────────────────────────

/** A persisted login read back after a restart; `principal` is null when its user is gone or disabled. */
export interface RestoredSession {
  createdAt: number
  lastActivity: number
  principal: SessionPrincipal | null
}

/** Restart-surviving login sessions; the security layer applies the TTLs. */
export interface PersistentSessionStore {
  persist(token: string, principal: SessionPrincipal, createdAt: number): Promise<void>
  restore(token: string): RestoredSession | null
  touch(token: string, lastActivity: number): Promise<void>
  remove(token: string): Promise<void>
  removeForUser(userId: string): Promise<void>
  clear(): Promise<void>
  /** Resolves once every change so far is on disk. */
  flush(): Promise<void>
}

/**
 * A long-lived socket: the host terminal, or the viewer of one managed
 * browser, which checks the caller against that browser on its own.
 */
export type SocketTransport = "terminal" | "browser"

/** An edition that signs in named users instead of the personal network password. */
export interface EditionAuth {
  /** Replaces the personal authMiddleware for every request. */
  middleware(req: IncomingMessage, res: ServerResponse, next: NextFn): void
  /** Answers POST /api/auth/verify once the shared source, HTTPS and rate-limit gates passed. */
  login(req: IncomingMessage, res: ServerResponse, browserLogin: boolean): Promise<void>
  /**
   * Whether `principal` may hold a `transport` socket now. Asked at the
   * upgrade and again at every re-check of an open socket, which closes once
   * the answer turns false.
   */
  admitsSocket(principal: SessionPrincipal, transport: SocketTransport): boolean
  /** Whether `principal` may act on what no session owns: host-wide items, project-wide defaults, plugins. */
  administers(principal: SessionPrincipal): boolean
  readonly sessions: PersistentSessionStore
}

// ── Browser profiles ─────────────────────────────────────────────────

/**
 * Which managed browser profile an agent's `default` opens. Null everywhere
 * keeps the host's own `default` profile; an edition with accounts gives each
 * one a profile of its own instead.
 */
export interface EditionBrowsers {
  /**
   * The profile a session's agent opens as `default`: its owner's own. Null
   * `sessionId` asks for an agent Cogpit cannot tie to a session, such as one
   * a shared process serves.
   */
  profileForSession(sessionId: string | null): string | null
  /** The caller's own profile, which stands in for `default` wherever they see browsers. */
  profileForCaller(req: IncomingMessage): string | null
  /** A name the edition hands out, which nobody may create by hand. */
  reservesName(name: string): boolean
  /** The display name of the account whose own profile `name` is. */
  accountOf(name: string): string | null
}

// ── The edition module ───────────────────────────────────────────────

export interface EditionBootContext {
  /** Where Cogpit keeps its own data; an edition keeps its stores under it. */
  dataRoot: string
}

/** What the standalone entry point knows when it prints its boot banner. */
export interface EditionBootNoticeInfo {
  envPasswordSet: boolean
  host: string
  port: number
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>
  /** COGPIT_PUBLIC_URL — the address browsers actually reach this server on. */
  publicUrl?: string | null
}

/**
 * Everything core asks of the running edition. Personal edition is
 * `PERSONAL_EDITION`; a build with an edition package installs its default
 * export at boot (./load.ts). Every member is required, so an edition states each behaviour it has.
 */
export interface EditionModule {
  readonly edition: CogpitEdition
  /** Opens the edition's stores. Runs before any route registers or anything can spawn a process. */
  boot(context: EditionBootContext): Promise<void>
  /** Waits for the edition's durable state to reach disk; shutdown may call it twice. */
  flush(): Promise<void>
  /** Null keeps personal authentication: local trust plus the network password. */
  readonly auth: EditionAuth | null
  /** Mounted right after authMiddleware: what the authenticated caller may reach. */
  authorize(req: IncomingMessage, res: ServerResponse, next: NextFn): void
  /** Whether a hub caller may reach a device's `downstreamPath` (null when it is malformed). */
  hubProxyRejection(req: IncomingMessage, downstreamPath: string | null, method: string): 401 | 403 | null
  me(req: IncomingMessage): MeResponse
  /** True while the server has no account to sign in with, so its first-time setup is open. */
  setupRequired(): boolean
  /** API path prefixes that answer before Cogpit is configured, such as the edition's first-time setup. */
  readonly unguardedApiPaths: readonly string[]
  bootNotices(info: EditionBootNoticeInfo): string[]
  /** The edition's own API routes, registered at the `edition` position. */
  registerRoutes(use: UseFn): void
  readonly access: EditionSessionAccess
  readonly activity: EditionActivity
  readonly browsers: EditionBrowsers
  readonly turns: EditionTurns
  readonly sessionSettings: EditionSessionSettings
  readonly notificationRetention: NotificationRetention
}
