import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts"
import type { SessionAction } from "@/hooks/useSessionState"
import type { RefObject, Dispatch } from "react"

function createOpts(overrides: Partial<Parameters<typeof useKeyboardShortcuts>[0]> = {}) {
  return {
    isMobile: false,
    searchInputRef: { current: null } as RefObject<HTMLInputElement | null>,
    chatInputRef: { current: null } as RefObject<{ focus: () => void; toggleVoice: () => void } | null>,
    dispatch: vi.fn() as Dispatch<SessionAction>,
    onToggleSidebar: vi.fn(),
    onOpenProjectSwitcher: vi.fn(),
    onOpenThemeSelector: vi.fn(),
    onOpenTerminal: vi.fn(),
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

  describe("Cmd+E / Ctrl+E - expand all", () => {
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

  describe("Cmd+Shift+E - collapse all", () => {
    it("dispatches SET_EXPAND_ALL false on Cmd+Shift+E", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("e", { metaKey: true, shiftKey: true })
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_EXPAND_ALL",
        value: false,
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

  describe("Cmd+Shift+M - toggle voice and focus chat", () => {
    it("focuses chat input and toggles voice", () => {
      const focusMock = vi.fn()
      const toggleVoiceMock = vi.fn()
      const chatInputRef = {
        current: { focus: focusMock, toggleVoice: toggleVoiceMock },
      } as unknown as RefObject<{ focus: () => void; toggleVoice: () => void } | null>
      const opts = createOpts({ chatInputRef })
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("M", { metaKey: true, shiftKey: true })
      expect(focusMock).toHaveBeenCalled()
      expect(toggleVoiceMock).toHaveBeenCalled()
    })

    it("does nothing when chatInputRef.current is null", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      // Should not throw
      fireKey("M", { metaKey: true, shiftKey: true })
    })
  })

  describe("Space - focus chat input", () => {
    it("focuses chat input when no input is focused", () => {
      const focusMock = vi.fn()
      const chatInputRef = {
        current: { focus: focusMock, toggleVoice: vi.fn() },
      } as unknown as RefObject<{ focus: () => void; toggleVoice: () => void } | null>
      const opts = createOpts({ chatInputRef })
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey(" ")
      expect(focusMock).toHaveBeenCalled()
    })

    it("does not focus chat input when an input is focused", () => {
      const focusMock = vi.fn()
      const chatInputRef = {
        current: { focus: focusMock, toggleVoice: vi.fn() },
      } as unknown as RefObject<{ focus: () => void; toggleVoice: () => void } | null>
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
        current: { focus: focusMock, toggleVoice: vi.fn() },
      } as unknown as RefObject<{ focus: () => void; toggleVoice: () => void } | null>
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
    it("works with ctrlKey for expand/collapse", () => {
      const opts = createOpts()
      renderHook(() => useKeyboardShortcuts(opts))

      fireKey("e", { ctrlKey: true, shiftKey: true })
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_EXPAND_ALL",
        value: false,
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
})
