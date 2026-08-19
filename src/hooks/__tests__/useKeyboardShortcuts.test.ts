import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts"
import { setMe, __resetCapabilitiesForTest } from "@/lib/capabilities"
import { MEMBER_CAPABILITIES } from "../../../shared/contracts/team"
import type { ChatInputHandle } from "@/components/ChatInput"
import type { SessionAction } from "@/hooks/useSessionState"
import type { RefObject, Dispatch } from "react"

function createOpts(overrides: Partial<Parameters<typeof useKeyboardShortcuts>[0]> = {}) {
  return {
    isMobile: false,
    searchInputRef: { current: null } as RefObject<HTMLInputElement | null>,
    chatInputRef: { current: null } as RefObject<ChatInputHandle | null>,
    dispatch: vi.fn() as Dispatch<SessionAction>,
    onToggleSidebar: vi.fn(),
    onToggleRightSidebar: vi.fn(),
    onToggleMissionControl: vi.fn(),
    onOpenProjectSwitcher: vi.fn(),
    onOpenThemeSelector: vi.fn(),
    onOpenTerminal: vi.fn(),
    onToggleIntegratedTerminal: vi.fn(),
    onTogglePreview: vi.fn(),
    onToggleProjectFiles: vi.fn(),
    onHistoryBack: vi.fn(() => null),
    onHistoryForward: vi.fn(() => null),
    onNavigateToSession: vi.fn(),
    ...overrides,
  }
}

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  })
  window.dispatchEvent(event)
  return event
}

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Clean up any leftover event listeners by unmounting hooks
  })

  describe("does nothing on mobile", () => {
    it("does not register keydown listener when isMobile is true", () => {
      const opts = createOpts({ isMobile: true })
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("e", { metaKey: true })
      expect(opts.dispatch).not.toHaveBeenCalled()
    })
  })

  describe("Cmd+K / Ctrl+K - open command palette", () => {
    it("opens the command palette and prevents the browser shortcut", () => {
      const onOpenCommandPalette = vi.fn()
      const opts = createOpts({ onOpenCommandPalette })
      renderHook(() => useKeyboardShortcuts(opts))

      const event = fireKey("k", { metaKey: true })

      expect(onOpenCommandPalette).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
    })

    it("works with Ctrl on Windows and Linux", () => {
      const onOpenCommandPalette = vi.fn()
      const opts = createOpts({ onOpenCommandPalette })
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("k", { ctrlKey: true })

      expect(onOpenCommandPalette).toHaveBeenCalledOnce()
    })
  })

  describe("Cmd+J / Ctrl+J - toggle integrated terminal", () => {
    it("toggles the integrated terminal and prevents the browser shortcut", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      const event = fireKey("j", { metaKey: true })

      expect(opts.onToggleIntegratedTerminal).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
    })

    it("works with Ctrl on Windows and Linux", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("j", { ctrlKey: true })

      expect(opts.onToggleIntegratedTerminal).toHaveBeenCalledOnce()
    })
  })

  describe("Cmd+Shift+J / Ctrl+Shift+J - toggle development preview", () => {
    it("toggles the preview and prevents the browser shortcut", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      const event = fireKey("j", { metaKey: true, shiftKey: true })

      expect(opts.onTogglePreview).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
      expect(opts.onToggleIntegratedTerminal).not.toHaveBeenCalled()
    })
  })

  describe("Cmd+Shift+F / Ctrl+Shift+F - toggle project files", () => {
    it("opens the project file workspace and prevents the browser shortcut", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      const event = fireKey("f", { metaKey: true, shiftKey: true })

      expect(opts.onToggleProjectFiles).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
    })
  })

  describe("Cmd+E / Ctrl+E - expand all groups", () => {
    it("dispatches SET_EXPAND_ALL true on Cmd+E", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("e", { metaKey: true })
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_EXPAND_ALL",
        value: true,
      })
    })

    it("dispatches SET_EXPAND_ALL true on Ctrl+E", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("e", { ctrlKey: true })
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_EXPAND_ALL",
        value: true,
      })
    })
  })

  describe("Cmd+Shift+E - expand all tool payloads", () => {
    it("dispatches SET_EXPAND_TOOL_PAYLOADS true on Cmd+Shift+E", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("e", { metaKey: true, shiftKey: true })
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_EXPAND_TOOL_PAYLOADS",
        value: true,
      })
    })
  })

  describe("Cmd+B - toggle sidebar", () => {
    it("calls onToggleSidebar on Cmd+B", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("b", { metaKey: true })
      expect(opts.onToggleSidebar).toHaveBeenCalled()
    })
  })

  describe("Cmd+Shift+B - toggle right sidebar", () => {
    it("calls onToggleRightSidebar on Cmd+Shift+B", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("B", { metaKey: true, shiftKey: true })
      expect(opts.onToggleRightSidebar).toHaveBeenCalled()
      expect(opts.onToggleSidebar).not.toHaveBeenCalled()
    })

    it("works with ctrlKey", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("B", { ctrlKey: true, shiftKey: true })
      expect(opts.onToggleRightSidebar).toHaveBeenCalled()
    })
  })

  describe("Cmd+Shift+M - toggle Mission Control", () => {
    it("calls onToggleMissionControl on Cmd+Shift+M", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("M", { metaKey: true, shiftKey: true })
      expect(opts.onToggleMissionControl).toHaveBeenCalled()
    })

    it("does not fire without the shift modifier", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("M", { metaKey: true })
      expect(opts.onToggleMissionControl).not.toHaveBeenCalled()
    })
  })

  describe("Escape - clear search", () => {
    it("dispatches SET_SEARCH_QUERY empty on Escape", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("Escape")
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_SEARCH_QUERY",
        value: "",
      })
    })

    it("blurs search input on Escape", () => {
      const blurMock = vi.fn()
      const searchInputRef = { current: { blur: blurMock } } as unknown as RefObject<HTMLInputElement | null>
      const opts = createOpts({ searchInputRef })
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("Escape")
      expect(blurMock).toHaveBeenCalled()
    })
  })

  describe("Space - focus chat input", () => {
    it("focuses chat input when no input is focused", () => {
      const focusMock = vi.fn()
      const chatInputRef = {
        current: { focus: focusMock },
      } as unknown as RefObject<ChatInputHandle | null>
      const opts = createOpts({ chatInputRef })
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey(" ")
      expect(focusMock).toHaveBeenCalled()
    })

    it("does not focus chat input when an input is focused", () => {
      const focusMock = vi.fn()
      const chatInputRef = {
        current: { focus: focusMock },
      } as unknown as RefObject<ChatInputHandle | null>
      const opts = createOpts({ chatInputRef })
      renderHook(() => useKeyboardShortcuts(opts))

      const input = document.createElement("input")
      document.body.appendChild(input)
      input.focus()

      fireKey(" ")
      expect(focusMock).not.toHaveBeenCalled()

      document.body.removeChild(input)
    })

    it("does not focus chat input when a textarea is focused", () => {
      const focusMock = vi.fn()
      const chatInputRef = {
        current: { focus: focusMock },
      } as unknown as RefObject<ChatInputHandle | null>
      const opts = createOpts({ chatInputRef })
      renderHook(() => useKeyboardShortcuts(opts))

      const textarea = document.createElement("textarea")
      document.body.appendChild(textarea)
      textarea.focus()

      fireKey(" ")
      expect(focusMock).not.toHaveBeenCalled()

      document.body.removeChild(textarea)
    })
  })

  describe("cleanup", () => {
    it("removes event listener on unmount", () => {
      const opts = createOpts()
      const { unmount } = renderHook(() => useKeyboardShortcuts(opts))

      unmount()

      // After unmount, keyboard events should not trigger dispatch
      fireKey("e", { metaKey: true })
      expect(opts.dispatch).not.toHaveBeenCalled()
    })
  })

  describe("unhandled keys", () => {
    it("does not dispatch for regular keys without modifier", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("e")
      fireKey("b")
      fireKey("a")
      expect(opts.dispatch).not.toHaveBeenCalled()
      expect(opts.onToggleSidebar).not.toHaveBeenCalled()
    })
  })

  describe("Ctrl+E (non-mac modifier)", () => {
    it("works with ctrlKey for payload expansion", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("e", { ctrlKey: true, shiftKey: true })
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_EXPAND_TOOL_PAYLOADS",
        value: true,
      })
    })
  })

  describe("Ctrl+B toggle sidebar", () => {
    it("works with ctrlKey", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("b", { ctrlKey: true })
      expect(opts.onToggleSidebar).toHaveBeenCalled()
    })
  })

  describe("Ctrl+Cmd+S - open theme selector", () => {
    it("calls onOpenThemeSelector on Ctrl+Cmd+S", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("s", { ctrlKey: true, metaKey: true })
      expect(opts.onOpenThemeSelector).toHaveBeenCalled()
    })
  })

  describe("Ctrl+Cmd+T - open terminal", () => {
    it("calls onOpenTerminal on Ctrl+Cmd+T", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("t", { ctrlKey: true, metaKey: true })
      expect(opts.onOpenTerminal).toHaveBeenCalled()
    })
  })

  describe("terminal capability gate (team member)", () => {
    afterEach(() => __resetCapabilitiesForTest())

    it("ignores both terminal shortcuts without the terminal capability", () => {
      setMe({
        authenticated: true,
        edition: "team",
        user: { id: "u_1", username: "alice", displayName: "Alice", role: "member", createdAt: 1 },
        capabilities: MEMBER_CAPABILITIES,
      })
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("t", { ctrlKey: true, metaKey: true })
      fireKey("j", { metaKey: true })

      expect(opts.onOpenTerminal).not.toHaveBeenCalled()
      expect(opts.onToggleIntegratedTerminal).not.toHaveBeenCalled()
    })

    it("ignores the project-files shortcut without host-file access", () => {
      setMe({
        authenticated: true,
        edition: "team",
        user: { id: "u_1", username: "alice", displayName: "Alice", role: "member", createdAt: 1 },
        capabilities: MEMBER_CAPABILITIES,
      })
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      const event = fireKey("f", { metaKey: true, shiftKey: true })

      expect(opts.onToggleProjectFiles).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false)
    })
  })

  describe("Cmd+Shift+Digit - jump to live session", () => {
    it("clicks the Nth live session button", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      // Create mock buttons
      const btn1 = document.createElement("button")
      btn1.setAttribute("data-live-session", "true")
      btn1.click = vi.fn()
      btn1.focus = vi.fn()
      document.body.appendChild(btn1)

      const btn2 = document.createElement("button")
      btn2.setAttribute("data-live-session", "true")
      btn2.click = vi.fn()
      btn2.focus = vi.fn()
      document.body.appendChild(btn2)

      fireKey("2", { metaKey: true, shiftKey: true, code: "Digit2" })

      // Should click the 2nd button (index 1)
      expect(btn2.click).toHaveBeenCalled()

      // Clean up
      document.body.removeChild(btn1)
      document.body.removeChild(btn2)
    })

    it("does nothing when no live session buttons exist", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      // Should not throw
      fireKey("1", { metaKey: true, shiftKey: true, code: "Digit1" })
      // No assertions needed - just verifying no crash
    })
  })

  describe("Cmd+Shift+Arrow - focus live sessions", () => {
    function addLiveSessionButton(): HTMLButtonElement {
      const btn = document.createElement("button")
      btn.setAttribute("data-live-session", "true")
      btn.focus = vi.fn()
      document.body.appendChild(btn)
      return btn
    }

    it("focuses the first live session on Cmd+Shift+ArrowDown", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))
      const first = addLiveSessionButton()
      const last = addLiveSessionButton()

      fireKey("ArrowDown", { metaKey: true, shiftKey: true })

      expect(first.focus).toHaveBeenCalled()
      expect(last.focus).not.toHaveBeenCalled()

      document.body.removeChild(first)
      document.body.removeChild(last)
    })

    it("focuses the last live session on Cmd+Shift+ArrowUp", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))
      const first = addLiveSessionButton()
      const last = addLiveSessionButton()

      fireKey("ArrowUp", { ctrlKey: true, shiftKey: true })

      expect(last.focus).toHaveBeenCalled()
      expect(first.focus).not.toHaveBeenCalled()

      document.body.removeChild(first)
      document.body.removeChild(last)
    })
  })

  describe("Ctrl+Tab - recent session switching", () => {
    const entry = { dirName: "-workspace-cogpit", fileName: "session-1.jsonl" }

    it("steps back through history on Ctrl+Tab", () => {
      const opts = createOpts({ onHistoryBack: vi.fn(() => entry) })
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("Tab", { ctrlKey: true })

      expect(opts.onHistoryBack).toHaveBeenCalled()
      expect(opts.onHistoryForward).not.toHaveBeenCalled()
      expect(opts.onNavigateToSession).toHaveBeenCalledWith(entry.dirName, entry.fileName)
    })

    it("steps forward through history on Ctrl+Shift+Tab", () => {
      const opts = createOpts({ onHistoryForward: vi.fn(() => entry) })
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("Tab", { ctrlKey: true, shiftKey: true })

      expect(opts.onHistoryForward).toHaveBeenCalled()
      expect(opts.onHistoryBack).not.toHaveBeenCalled()
    })

    it("ignores Cmd+Tab so the macOS app switcher still works", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("Tab", { metaKey: true })

      expect(opts.onHistoryBack).not.toHaveBeenCalled()
      expect(opts.onHistoryForward).not.toHaveBeenCalled()
    })
  })
})
