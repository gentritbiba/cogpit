import type { TeamRole } from "../../shared/contracts/team"

/**
 * Leaf module for the pieces security.ts shares with the team modules it
 * imports (sessionPersistence, requestPrincipal). Those modules must never
 * import security.ts back — that would be an import cycle — so the shared
 * pieces live here and security.ts re-exports them.
 */

export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000

/** The authenticated user a team-edition session token was issued to. */
export interface SessionPrincipal {
  userId: string
  username: string
  role: TeamRole
}
