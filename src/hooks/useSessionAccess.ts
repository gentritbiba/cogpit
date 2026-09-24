import { useEffect, useSyncExternalStore } from "react"
import { useCurrentUser } from "@/hooks/useCurrentUser"
import {
  knownSessionAccess,
  subscribeSessionAccess,
  watchSessionAccess,
} from "@/lib/sessionAccess"
import type { SessionAccessState } from "@/lib/sessionAccessPermissions"

export interface SessionAccess {
  /** "unknown" only where the server enforces session access, until a session list or the server says; the session is read-only meanwhile. */
  level: SessionAccessState
}

const OWN: SessionAccess = { level: "own" }
const UNKNOWN: SessionAccess = { level: "unknown" }
const KNOWN: Record<Exclude<SessionAccessState, "unknown">, SessionAccess> = {
  none: { level: "none" },
  view: { level: "view" },
  interact: { level: "interact" },
  own: OWN,
}

/**
 * The signed-in user's access to a session. On a server that does not enforce
 * session access every session, like one not created yet, is the user's own and
 * the server is never asked. Where it does, this reads what session lists and
 * the server have said, asks the server while the session is open, and is
 * "unknown" until someone answers. An unresolved identity is "unknown"
 * throughout.
 */
export function useSessionAccess(sessionId: string | null): SessionAccess {
  const { enforcesSessionAccess } = useCurrentUser()
  const checkedSessionId = enforcesSessionAccess ? sessionId : null
  const readKnown = () => (checkedSessionId ? knownSessionAccess(checkedSessionId) : undefined)
  const known = useSyncExternalStore(subscribeSessionAccess, readKnown, readKnown)

  useEffect(() => (checkedSessionId ? watchSessionAccess(checkedSessionId) : undefined), [checkedSessionId])

  if (enforcesSessionAccess === null) return UNKNOWN
  if (!checkedSessionId) return OWN
  return known ? KNOWN[known] : UNKNOWN
}
