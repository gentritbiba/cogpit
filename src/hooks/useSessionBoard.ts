import { useCallback, useEffect, useState } from "react"
import { authFetch } from "@/lib/auth"
import { useVisiblePolling } from "@/hooks/useVisiblePolling"
import type { SessionBoard } from "../../shared/contracts/board"

const POLL_INTERVAL = 5_000

/** The board a session keeps, kept current while the tab is visible; null when it keeps none. */
export function useSessionBoard(sessionId: string | null): SessionBoard | null {
  const [board, setBoard] = useState<SessionBoard | null>(null)
  const poll = useCallback(async (isActive: () => boolean) => {
    if (!sessionId) return
    try {
      const response = await authFetch(`/api/session-board/${encodeURIComponent(sessionId)}`)
      if (!isActive() || !response.ok) return
      const { board: next } = await response.json() as { board: SessionBoard | null }
      if (!isActive()) return
      setBoard((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
    } catch {
      // The next poll retries.
    }
  }, [sessionId])
  useVisiblePolling(sessionId ? poll : null, POLL_INTERVAL)
  useEffect(() => {
    setBoard((current) => (current?.sessionId === sessionId ? current : null))
  }, [sessionId])
  return board
}
