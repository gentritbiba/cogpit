import { useEffect } from "react"
import { toast } from "sonner"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { forgetSessionAccess, hadSessionAccess, publishListsStale } from "@/lib/sessionAccess"
import { deletedHere, onSessionAccessChanged, onSessionAccessLost, onSessionDeleted } from "@/lib/sessionAccessEvents"
import { sessionCache } from "@/lib/sessionCache"
import { evictSessionFromLists } from "@/lib/sessionListCache"

export const ACCESS_LOST_MESSAGE = "You no longer have access to this session"
/** For a session this client never knew the caller to reach, such as one opened by its URL. */
export const NO_ACCESS_MESSAGE = "You don't have access to this session"

interface SessionAccessLossOptions {
  /** The top-level session the open view shows, or null. */
  openSessionId: string | null
  /** Leave the open session's view. */
  leave: () => void
  /** Forget the session in the switcher's history. */
  forgetVisits: (sessionId: string) => void
}

/**
 * The one listener for what the server says about the caller's access. A
 * session they lost leaves every cache — its transcripts, every cached list,
 * the switcher history and the access store — with a toast, and its view if
 * it is open. The toast says the access was lost only when this client knew
 * the caller to have had some. A session they deleted, or that only a background request found
 * lost while another was open, leaves the same way without the toast. A
 * changed level makes the lists that show access list again; the open session
 * re-reads its own level where it is watched.
 */
export function useSessionAccessLoss({ openSessionId, leave, forgetVisits }: SessionAccessLossOptions): void {
  const { removeSession } = useSessionInventory()

  useEffect(() => {
    function drop(sessionId: string): void {
      sessionCache.evictSession(sessionId)
      evictSessionFromLists(sessionId)
      forgetSessionAccess(sessionId)
      removeSession(sessionId)
      forgetVisits(sessionId)
      publishListsStale()
      if (sessionId === openSessionId) leave()
    }
    const stopLost = onSessionAccessLost((sessionId, background) => {
      const message = hadSessionAccess(sessionId) ? ACCESS_LOST_MESSAGE : NO_ACCESS_MESSAGE
      drop(sessionId)
      // A hover prefetch of a stale row is no news about what the user is looking at.
      if (background && sessionId !== openSessionId) return
      void deletedHere(sessionId).then((deleted) => {
        // One toast per session, however many requests and streams said so.
        if (!deleted) toast.error(message, { id: `session-access-lost:${sessionId}` })
      })
    })
    const stopDeleted = onSessionDeleted(drop)
    return () => {
      stopLost()
      stopDeleted()
    }
  }, [openSessionId, leave, forgetVisits, removeSession])

  useEffect(() => onSessionAccessChanged(() => publishListsStale()), [])
}
