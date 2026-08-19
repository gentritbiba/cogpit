import { useEffect, type RefObject, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"
import type { ChatInputHandle } from "@/components/ChatInput"
import { can } from "@/lib/capabilities"
import { isEditableTarget, matchesKeybinding } from "@/lib/keybindings"

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
  onToggleRightSidebar: () => void
  onToggleMissionControl: () => void
  onOpenCommandPalette?: () => void
  onOpenProjectSwitcher: () => void
  onOpenThemeSelector: () => void
  onOpenTerminal: () => void
  onToggleIntegratedTerminal: () => void
  onTogglePreview: () => void
  onToggleProjectFiles: () => void
  onHistoryBack: () => HistoryEntry | null
  onHistoryForward: () => HistoryEntry | null
  onNavigateToSession: (dirName: string, fileName: string) => void
  onCommitNavigation?: () => void
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
  onToggleRightSidebar,
  onToggleMissionControl,
  onOpenCommandPalette,
  onOpenProjectSwitcher,
  onOpenThemeSelector,
  onOpenTerminal,
  onToggleIntegratedTerminal,
  onTogglePreview,
  onToggleProjectFiles,
  onHistoryBack,
  onHistoryForward,
  onNavigateToSession,
  onCommitNavigation,
}: UseKeyboardShortcutsOpts) {
  useEffect(() => {
    if (isMobile) return
    function handleKeyDown(e: KeyboardEvent) {
      if (matchesKeybinding("commandPalette", e)) {
        e.preventDefault()
        onOpenCommandPalette?.()
        return
      }

      if (matchesKeybinding("integratedTerminal", e)) {
        if (!can("terminal")) return
        e.preventDefault()
        onToggleIntegratedTerminal()
        return
      }

      if (matchesKeybinding("preview", e)) {
        e.preventDefault()
        onTogglePreview()
        return
      }

      if (matchesKeybinding("projectFiles", e)) {
        if (!can("hostFiles")) return
        e.preventDefault()
        onToggleProjectFiles()
        return
      }

      if (matchesKeybinding("expandAll", e)) {
        e.preventDefault()
        dispatch({ type: "SET_EXPAND_ALL", value: true })
        return
      }
      if (matchesKeybinding("collapseAll", e)) {
        e.preventDefault()
        dispatch({ type: "SET_EXPAND_ALL", value: false })
        return
      }
      if (matchesKeybinding("toggleSidebar", e)) {
        e.preventDefault()
        onToggleSidebar()
        return
      }
      if (matchesKeybinding("toggleStats", e)) {
        e.preventDefault()
        onToggleRightSidebar()
        return
      }
      if (matchesKeybinding("missionControl", e)) {
        e.preventDefault()
        onToggleMissionControl()
        return
      }

      if (matchesKeybinding("newSession", e)) {
        e.preventDefault()
        onOpenProjectSwitcher()
      }

      if (matchesKeybinding("themeSelector", e)) {
        e.preventDefault()
        onOpenThemeSelector()
      }

      if (matchesKeybinding("systemTerminal", e)) {
        if (!can("terminal")) return
        e.preventDefault()
        onOpenTerminal()
      }

      if (e.key === "Escape") {
        dispatch({ type: "SET_SEARCH_QUERY", value: "" })
        searchInputRef.current?.blur()
      }

      // Mod+Shift+1–9 — jump to the Nth live session. Matched on `e.code` (not
      // `e.key`) because Shift+Digit yields "!" … ")" on most layouts, so this
      // stays outside KEYBINDING_DEFINITIONS and is not rebindable.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code.startsWith("Digit")) {
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

      // Ctrl+Tab / Ctrl+Shift+Tab — MRU session switching (like Firefox tabs).
      // Only Ctrl (not Cmd) since Cmd+Tab is the macOS app switcher, and in
      // browsers Ctrl+Tab switches browser tabs, so this only works in Electron.
      const recentForward = matchesKeybinding("recentSessionForward", e)
      if (recentForward || matchesKeybinding("recentSessionBack", e)) {
        e.preventDefault()
        const entry = recentForward ? onHistoryForward() : onHistoryBack()
        if (entry) {
          onNavigateToSession(entry.dirName, entry.fileName)
        }
      }

      // Space — focus chat input, unless the user is already typing somewhere
      if (matchesKeybinding("focusComposer", e) && !isEditableTarget(document.activeElement)) {
        e.preventDefault()
        chatInputRef.current?.focus()
      }

      // Mod+Shift+Arrow — navigate between live sessions (Enter to open)
      const nextLive = matchesKeybinding("nextLiveSession", e)
      if (nextLive || matchesKeybinding("prevLiveSession", e)) {
        e.preventDefault()
        const buttons = getLiveSessionButtons()
        if (buttons.length === 0) return

        const currentIdx = buttons.findIndex((btn) => btn === document.activeElement)
        let nextIdx: number
        if (currentIdx === -1) {
          nextIdx = nextLive ? 0 : buttons.length - 1
        } else {
          nextIdx = Math.max(0, Math.min(buttons.length - 1, currentIdx + (nextLive ? 1 : -1)))
        }
        focusSession(buttons[nextIdx])
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      // When Ctrl is released after Ctrl+Tab navigation, commit the selection
      if (e.key === "Control") {
        onCommitNavigation?.()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
    }
  }, [isMobile, searchInputRef, chatInputRef, dispatch, onToggleSidebar, onToggleRightSidebar, onToggleMissionControl, onOpenCommandPalette, onOpenProjectSwitcher, onOpenThemeSelector, onOpenTerminal, onToggleIntegratedTerminal, onTogglePreview, onToggleProjectFiles, onHistoryBack, onHistoryForward, onNavigateToSession, onCommitNavigation])
}
