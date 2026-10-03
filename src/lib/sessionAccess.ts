// ── Per-session access ──────────────────────────────────────────────────
//
// The signed-in user's level in each session, where the server enforces
// session access, cached per device and user. Session lists seed it, the
// per-session lookup answers it, and an accepted change replaces it. Every
// answer carries a ticket taken when it was asked for, so one asked for
// earlier never overwrites what was learned since.

import { authFetch } from "@/lib/auth"
import { getCurrentUser } from "@/lib/capabilities"
import { deviceScopedKey } from "@/lib/device"
import { readJson } from "@/lib/httpJson"
import { isLossRefusal, onSessionAccessChanged } from "@/lib/sessionAccessEvents"
import {
  SESSION_ACCESS_PATH,
  type ListedAccess,
  type SessionAccessLevel,
  type SessionAccessLookup,
} from "../../shared/contracts/sessionAccess"

/** "none" is the server's definite no: the caller cannot open the session. */
export type KnownSessionAccess = SessionAccessLevel | "none"

/** A session list row; a server that enforces session access annotates each with the caller's access. */
export interface ListedSession {
  sessionId: string
  access?: ListedAccess
}

interface Entry {
  level: KnownSessionAccess
  ticket: number
}

const LEVELS: readonly SessionAccessLevel[] = ["view", "interact", "own"]
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

const entries = new Map<string, Entry>()
/** Sessions this client has known the caller to reach, whatever it learned since. */
const reached = new Set<string>()
const inflight = new Map<string, Promise<KnownSessionAccess | null>>()
const listeners = new Set<() => void>()
const staleListListeners = new Set<() => void>()
let lastTicket = 0

function cacheKey(sessionId: string): string {
  return `${deviceScopedKey("session-access")}::${sessionId}`
}

function notify(targets: ReadonlySet<() => void>): void {
  for (const listener of targets) listener()
}

/** Stores `level` unless something newer is already there; true when what readers see changed. */
function remember(key: string, level: KnownSessionAccess, ticket: number): boolean {
  if (level !== "none") reached.add(key)
  const current = entries.get(key)
  if (current && current.ticket > ticket) return false
  entries.set(key, { level, ticket })
  return current?.level !== level
}

function isLookup(value: unknown): value is SessionAccessLookup {
  return LEVELS.includes((value as Partial<SessionAccessLookup> | null)?.level as SessionAccessLevel)
}

export function knownSessionAccess(sessionId: string): KnownSessionAccess | undefined {
  return entries.get(cacheKey(sessionId))?.level
}

/** Whether this client ever knew the caller to have any access to the session. */
export function hadSessionAccess(sessionId: string): boolean {
  return reached.has(cacheKey(sessionId))
}

export function subscribeSessionAccess(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Take before asking the server anything; hand it back with the answer. */
export function sessionAccessTicket(): number {
  lastTicket += 1
  return lastTicket
}

/** Learn each row's access from a list requested under `ticket`. Rows without access are skipped. */
export function learnListedAccess(rows: readonly ListedSession[], ticket: number): void {
  let changed = false
  for (const { sessionId, access } of rows) {
    if (access) changed = remember(cacheKey(sessionId), access.level, ticket) || changed
  }
  if (changed) notify(listeners)
}

/**
 * The server's answer, or null when it gave no usable one. Only a 404 that
 * carries the access header is a definite no: a server that has no lookup
 * answers a plain 404, which says nothing about the session.
 */
async function lookUp(sessionId: string): Promise<KnownSessionAccess | null> {
  let res: Response
  try {
    res = await authFetch(`${SESSION_ACCESS_PATH}${encodeURIComponent(sessionId)}`)
  } catch {
    return null
  }
  if (res.status === 404 && isLossRefusal(res)) return "none"
  if (!res.ok) return null
  const body = await readJson(res)
  return isLookup(body) ? body.level : null
}

async function readSessionAccess(sessionId: string, key: string): Promise<KnownSessionAccess | null> {
  const ticket = sessionAccessTicket()
  const level = await lookUp(sessionId)
  if (level === null) return null
  if (remember(key, level, ticket)) notify(listeners)
  return entries.get(key)?.level ?? null
}

/** Ask again even if a request is out: something changed after it was sent. */
export function rereadSessionAccess(sessionId: string): Promise<KnownSessionAccess | null> {
  const key = cacheKey(sessionId)
  const request = readSessionAccess(sessionId, key).finally(() => {
    if (inflight.get(key) === request) inflight.delete(key)
  })
  inflight.set(key, request)
  return request
}

/**
 * Ask the server for the caller's access to a session. Resolves to what is
 * known afterwards, or null when the server gave no usable answer. Callers
 * asking while a request is out share it.
 */
export function refreshSessionAccess(sessionId: string): Promise<KnownSessionAccess | null> {
  return inflight.get(cacheKey(sessionId)) ?? rereadSessionAccess(sessionId)
}

/** Keep the level the server gave in answer to something asked under `ticket`. */
export function publishSessionAccess(sessionId: string, level: SessionAccessLevel, ticket: number): void {
  if (remember(cacheKey(sessionId), level, ticket)) notify(listeners)
}

/** The server said the caller can no longer see the session. */
export function forgetSessionAccess(sessionId: string): void {
  if (remember(cacheKey(sessionId), "none", sessionAccessTicket())) notify(listeners)
}

/** A session this client just created belongs to its creator; nothing to ask. */
export function rememberCreatedSession(sessionId: string): void {
  const { enforcesSessionAccess, user } = getCurrentUser()
  if (!enforcesSessionAccess || !user) return
  if (remember(cacheKey(sessionId), "own", sessionAccessTicket())) notify(listeners)
}

/** What session lists show changed on the server, such as who may see a session; lists refetch. */
export function publishListsStale(): void {
  notify(staleListListeners)
}

export function onListsStale(listener: () => void): () => void {
  staleListListeners.add(listener)
  return () => staleListListeners.delete(listener)
}

/**
 * Keep an open session's access current: ask now, again whenever the server
 * says it changed, and after a failure with a delay that doubles from one
 * second up to thirty. A definite no is the server's final word. Returns the
 * stop.
 */
export function watchSessionAccess(sessionId: string): () => void {
  let stopped = false
  let failures = 0
  let latest = 0
  let retry: ReturnType<typeof setTimeout> | undefined

  async function read(request: () => Promise<KnownSessionAccess | null>): Promise<void> {
    const attempt = ++latest
    clearTimeout(retry)
    const known = await request()
    // Only the newest read decides whether to try again.
    if (stopped || attempt !== latest) return
    if (known) {
      failures = 0
      return
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS)
    failures += 1
    retry = setTimeout(() => void read(() => refreshSessionAccess(sessionId)), delay)
  }

  void read(() => refreshSessionAccess(sessionId))
  const stopListening = onSessionAccessChanged(() => {
    failures = 0
    void read(() => rereadSessionAccess(sessionId))
  }, sessionId)
  return () => {
    stopped = true
    clearTimeout(retry)
    stopListening()
  }
}

export function __resetSessionAccessForTest(): void {
  entries.clear()
  reached.clear()
  inflight.clear()
}
