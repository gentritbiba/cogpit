/**
 * Leaf module for the session pieces security.ts shares with the modules an
 * edition plugs into it (session persistence, the request principal). Those
 * must never import security.ts back — that would be an import cycle — so the
 * shared pieces live here and security.ts re-exports them.
 */

export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000

/** The account a session token was issued to, where the edition signs in accounts. */
export interface SessionPrincipal {
  userId: string
  username: string
  /** Defined by the edition. */
  role: string
}
