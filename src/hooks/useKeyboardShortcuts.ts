import { useEffect, type RefObject, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"

interface UseKeyboardShortcutsOpts {
  isMobile: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  dispatch: Dispatch<SessionAction>
  onToggleSidebar: () => void
}

export function useKeyboardShortcuts({
  isMobile,
  searchInputRef,
  dispatch,
  onToggleSidebar,
}: UseKeyboardShortcutsOpts) {
  useEffect(() => {
    if (isMobile) return
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "e" && !e.shiftKey) {
        e.preventDefault()
        dispatch({ type: "SET_EXPAND_ALL", value: true })
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "e" && e.shiftKey) {
        e.preventDefault()
        dispatch({ type: "SET_EXPAND_ALL", value: false })
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault()
        onToggleSidebar()
      }
      if (e.key === "Escape") {
        dispatch({ type: "SET_SEARCH_QUERY", value: "" })
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isMobile, searchInputRef, dispatch, onToggleSidebar])
}
