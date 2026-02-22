import { useRef, useCallback } from "react"

interface HistoryEntry {
  dirName: string
  fileName: string
}

const STORAGE_KEY = "cogpit-session-history"
const MAX_HISTORY = 50

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.slice(0, MAX_HISTORY)
  } catch { /* corrupt or unavailable */ }
  return []
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch { /* quota exceeded or unavailable */ }
}

/**
 * Tracks MRU (most recently used) session history for Ctrl+Tab switching.
 * Works like Firefox's Ctrl+Tab — cycles through sessions in visit order,
 * wrapping around at the ends. When Ctrl is released, the selected session
 * is promoted to MRU position. History is persisted to localStorage so
 * order survives app restarts.
 */
export function useSessionHistory() {
  const history = useRef<HistoryEntry[]>(loadHistory())
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
    if (history.current.length > MAX_HISTORY) history.current.length = MAX_HISTORY
    // Reset navigation index
    indexRef.current = 0
    // Persist
    saveHistory(history.current)
  }, [])

  /** Navigate to the previous session in MRU order (wraps around). */
  const goBack = useCallback((): HistoryEntry | null => {
    if (history.current.length <= 1) return null
    const next = (indexRef.current + 1) % history.current.length
    indexRef.current = next
    navigatingRef.current = true
    return history.current[next]
  }, [])

  /** Navigate forward in MRU order (wraps around). */
  const goForward = useCallback((): HistoryEntry | null => {
    if (history.current.length <= 1) return null
    const next = (indexRef.current - 1 + history.current.length) % history.current.length
    indexRef.current = next
    navigatingRef.current = true
    return history.current[next]
  }, [])

  /**
   * Commit the current navigation position — called when Ctrl is released.
   * Moves the selected entry to the front of the MRU history.
   */
  const commitNavigation = useCallback(() => {
    if (indexRef.current === 0) {
      navigatingRef.current = false
      return
    }
    // Move the selected entry to the front of history
    const entry = history.current[indexRef.current]
    if (entry) {
      history.current.splice(indexRef.current, 1)
      history.current.unshift(entry)
      saveHistory(history.current)
    }
    indexRef.current = 0
    navigatingRef.current = false
  }, [])

  return { push, goBack, goForward, commitNavigation }
}
