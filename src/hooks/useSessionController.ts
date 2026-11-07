import { useCallback, useState, type Dispatch } from "react"
import type { SessionView } from "../../shared/session/sessionDigest"
import type { SessionAction } from "@/hooks/useSessionState"
import { createSessionController, type SessionController } from "@/lib/sessionLoader"

/** Actions that take the open session off the screen without opening another. */
const LEAVES: ReadonlySet<SessionAction["type"]> = new Set(["GO_HOME", "CLOSE_SESSION", "INIT_PENDING_SESSION"])

/**
 * One open controller per session shell, and the dispatch that shell should
 * use everywhere: leaving the session through it cancels any open still on
 * its way, so a slow load never lands after the user went elsewhere.
 */
export function useSessionController(
  dispatchState: Dispatch<SessionAction>,
  parse: (text: string) => Promise<SessionView>,
): { sessions: SessionController; dispatch: Dispatch<SessionAction> } {
  const [sessions] = useState(() => createSessionController({ parse, dispatch: dispatchState }))

  const dispatch = useCallback((action: SessionAction) => {
    if (LEAVES.has(action.type)) sessions.leave()
    dispatchState(action)
  }, [sessions, dispatchState])

  return { sessions, dispatch }
}
