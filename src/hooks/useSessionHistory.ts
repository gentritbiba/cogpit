import { useRef, useCallback } from "react"

interface HistoryEntry {
  dirName: string
  fileName: string
}

/**
 * Tracks MRU (most recently used) session history for Ctrl+Tab switching.
 * Works like Firefox's Ctrl+Tab — cycles through sessions in visit order.
 */
export function useSessionHistory() {
  const history = useRef<HistoryEntry[]>([])
  const indexRef = useRef(0)
  const navigatingRef = useRef(false)

  /** Record a session visit. Skipped automatically during history navigation. */
  const push = useCallback((dirName: string, fileName: string) => {
    if (navigatingRef.current) {
      navigatingRef.current = false
      return
    }
    const key = `${dirName}/${fileName}`
    // Remove duplicate if already in history
    history.current = history.current.filter(
      (e) => `${e.dirName}/${e.fileName}` !== key
    )
    // Add to front (most recent)
    history.current.unshift({ dirName, fileName })
    // Cap size
    if (history.current.length > 50) history.current.length = 50
    // Reset navigation index
    indexRef.current = 0
  }, [])

  /** Navigate to the previous session in MRU order. Returns the entry or null. */
  const goBack = useCallback((): HistoryEntry | null => {
    const next = indexRef.current + 1
    if (next >= history.current.length) return null
    indexRef.current = next
    navigatingRef.current = true
    return history.current[next]
  }, [])

  /** Navigate forward (undo a goBack). Returns the entry or null. */
  const goForward = useCallback((): HistoryEntry | null => {
    const next = indexRef.current - 1
    if (next < 0) return null
    indexRef.current = next
    navigatingRef.current = true
    return history.current[next]
  }, [])

  return { push, goBack, goForward }
}
