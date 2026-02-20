import { useEffect, type RefObject, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"
import type { ChatInputHandle } from "@/components/ChatInput"

interface HistoryEntry {
  dirName: string
  fileName: string
}

interface UseKeyboardShortcutsOpts {
  isMobile: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  chatInputRef: RefObject<ChatInputHandle | null>
  dispatch: Dispatch<SessionAction>
  onToggleSidebar: () => void
  onOpenProjectSwitcher: () => void
  onHistoryBack: () => HistoryEntry | null
  onHistoryForward: () => HistoryEntry | null
  onNavigateToSession: (dirName: string, fileName: string) => void
}

/** Query all live-session buttons in DOM order */
function getLiveSessionButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-live-session]"))
}

/** Find the nearest scrollable ancestor */
function getScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll") return node
    node = node.parentElement
  }
  return null
}

/** Focus a session button and scroll it into view within the sidebar only */
function focusSession(btn: HTMLButtonElement) {
  btn.focus({ preventScroll: true })
  const scroller = getScrollParent(btn)
  if (scroller) {
    const scrollerRect = scroller.getBoundingClientRect()
    const btnRect = btn.getBoundingClientRect()
    if (btnRect.top < scrollerRect.top) {
      scroller.scrollTop -= scrollerRect.top - btnRect.top + 8
    } else if (btnRect.bottom > scrollerRect.bottom) {
      scroller.scrollTop += btnRect.bottom - scrollerRect.bottom + 8
    }
  }
}

export function useKeyboardShortcuts({
  isMobile,
  searchInputRef,
  chatInputRef,
  dispatch,
  onToggleSidebar,
  onOpenProjectSwitcher,
  onHistoryBack,
  onHistoryForward,
  onNavigateToSession,
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

      // Ctrl+Shift+M — toggle voice input and focus chat
      if (mod && e.shiftKey && e.key === "M") {
        e.preventDefault()
        chatInputRef.current?.focus()
        chatInputRef.current?.toggleVoice()
      }
      // Ctrl+Cmd+N (Mac) or Ctrl+Alt+N (Windows/Linux) — open project switcher
      if (e.ctrlKey && (e.metaKey || e.altKey) && e.key === "n") {
        e.preventDefault()
        onOpenProjectSwitcher()
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

      // Ctrl+Tab / Ctrl+Shift+Tab — MRU session switching (like Firefox tabs)
      // Only Ctrl (not Cmd) since Cmd+Tab is macOS app switcher.
      // In browsers, Ctrl+Tab switches browser tabs so this naturally only works in Electron.
      if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
        e.preventDefault()
        const entry = e.shiftKey ? onHistoryForward() : onHistoryBack()
        if (entry) {
          onNavigateToSession(entry.dirName, entry.fileName)
        }
      }

      // Space (no modifier, no focused input) — focus chat input
      if (
        e.key === " " &&
        !mod &&
        !e.shiftKey &&
        !e.altKey
      ) {
        const tag = (document.activeElement as HTMLElement)?.tagName
        const isEditable =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          (document.activeElement as HTMLElement)?.isContentEditable
        if (!isEditable) {
          e.preventDefault()
          chatInputRef.current?.focus()
        }
      }

      // Ctrl+Shift+ArrowDown/Up — navigate between live sessions (Enter to open)
      if (mod && e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault()
        const buttons = getLiveSessionButtons()
        if (buttons.length === 0) return

        const currentIdx = buttons.findIndex((btn) => btn === document.activeElement)
        let nextIdx: number
        if (currentIdx === -1) {
          nextIdx = e.key === "ArrowDown" ? 0 : buttons.length - 1
        } else {
          const delta = e.key === "ArrowDown" ? 1 : -1
          nextIdx = Math.max(0, Math.min(buttons.length - 1, currentIdx + delta))
        }
        focusSession(buttons[nextIdx])
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isMobile, searchInputRef, chatInputRef, dispatch, onToggleSidebar, onOpenProjectSwitcher, onHistoryBack, onHistoryForward, onNavigateToSession])
}
