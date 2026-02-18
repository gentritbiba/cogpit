import { useEffect, type RefObject, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"

interface UseKeyboardShortcutsOpts {
  isMobile: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  dispatch: Dispatch<SessionAction>
  onToggleSidebar: () => void
}

/** Query all live-session buttons in DOM order */
function getLiveSessionButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-live-session]"))
}

/** Focus a session button and scroll it into view */
function focusSession(btn: HTMLButtonElement) {
  btn.focus()
  btn.scrollIntoView({ block: "nearest", behavior: "smooth" })
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
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key === "e" && !e.shiftKey) {
        e.preventDefault()
        dispatch({ type: "SET_EXPAND_ALL", value: true })
      }
      if (mod && e.key === "e" && e.shiftKey) {
        e.preventDefault()
        dispatch({ type: "SET_EXPAND_ALL", value: false })
      }
      if (mod && e.key === "b") {
        e.preventDefault()
        onToggleSidebar()
      }
      if (e.key === "Escape") {
        dispatch({ type: "SET_SEARCH_QUERY", value: "" })
        searchInputRef.current?.blur()
      }

      // Ctrl+Shift+1–9 — jump to the Nth live session
      if (mod && e.shiftKey && e.code.startsWith("Digit")) {
        const num = parseInt(e.code.charAt(5), 10)
        if (num >= 1 && num <= 9) {
          e.preventDefault()
          const buttons = getLiveSessionButtons()
          const target = buttons[num - 1]
          if (target) {
            focusSession(target)
            target.click()
          }
        }
      }

      // Ctrl+Shift+ArrowDown/Up — navigate between live sessions
      if (mod && e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault()
        const buttons = getLiveSessionButtons()
        if (buttons.length === 0) return

        const currentIdx = buttons.findIndex((btn) => btn === document.activeElement)
        let nextIdx: number
        if (currentIdx === -1) {
          // Nothing focused — start from top or bottom
          nextIdx = e.key === "ArrowDown" ? 0 : buttons.length - 1
        } else {
          const delta = e.key === "ArrowDown" ? 1 : -1
          nextIdx = Math.max(0, Math.min(buttons.length - 1, currentIdx + delta))
        }
        focusSession(buttons[nextIdx])
        buttons[nextIdx].click()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isMobile, searchInputRef, dispatch, onToggleSidebar])
}
