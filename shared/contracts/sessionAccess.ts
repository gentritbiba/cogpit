// Browser-safe per-session access contracts (dependency rule 1: no runtime imports).

/** What the caller may do in a session, where the server decides that per session. */
export type SessionAccessLevel = "view" | "interact" | "own"

const ACCESS_RANK: Record<"none" | SessionAccessLevel, number> = { none: 0, view: 1, interact: 2, own: 3 }

/** Whether `level` grants at least what `needed` asks for. */
export function accessAtLeast(level: "none" | SessionAccessLevel, needed: SessionAccessLevel): boolean {
  return ACCESS_RANK[level] >= ACCESS_RANK[needed]
}

/**
 * The caller's access as a session list row carries it, where the server
 * enforces session access. An edition may attach more.
 */
export interface ListedAccess {
  level: SessionAccessLevel
  /** The session is the caller's own. */
  mine: boolean
}

/** GET `SESSION_ACCESS_PATH` + the session id answers a `SessionAccessLookup`, or 404 with the access header when the caller has none. */
export const SESSION_ACCESS_PATH = "/api/session-access/"

export interface SessionAccessLookup {
  sessionId: string
  level: SessionAccessLevel
}

/** Response header naming the caller's level on a refused session request. */
export const SESSION_ACCESS_HEADER = "X-Cogpit-Session-Access"

/**
 * Response header naming the session a refusal is about, as the request spelled
 * it (a transcript address by the session it is filed under), so the same
 * request is answered the same whether the session exists or not.
 */
export const SESSION_ID_HEADER = "X-Cogpit-Session-Id"

/** The named server-sent event a session stream carries when the caller's access to its session changes. */
export const SESSION_ACCESS_EVENT = "access"

/** The data of a `SESSION_ACCESS_EVENT` frame; the stream ends after a `none`. */
export interface SessionAccessFrame {
  sessionId: string
  level: "none" | SessionAccessLevel
}

/**
 * The named server-sent event a session stream carries whenever the session's
 * stored config changes, whoever changed it; the client reads the config again.
 */
export const SESSION_CONFIG_EVENT = "session-config"

/** The data of a `SESSION_CONFIG_EVENT` frame. */
export interface SessionConfigFrame {
  sessionId: string
}

/** Which sessions a list asks for, from its `scope` query parameter. Its values are the edition's; core passes them on. */
export type ListScope = string

/** The scope of a list request that names none: every session the caller may see. */
export const DEFAULT_LIST_SCOPE: ListScope = "all"
