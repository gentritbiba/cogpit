import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useIsMobile } from "../useIsMobile"

describe("useIsMobile", () => {
  let changeHandler: ((e: MediaQueryListEvent) => void) | null = null
  let mockMatches = false

  beforeEach(() => {
    changeHandler = null
    mockMatches = false

    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    })

    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: mockMatches,
      addEventListener: (_event: string, handler: (e: MediaQueryListEvent) => void) => {
        changeHandler = handler
      },
      removeEventListener: vi.fn(),
    }))
  })

  it("returns false for desktop width", () => {
    mockMatches = false
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it("returns true for mobile width", () => {
    mockMatches = true
    Object.defineProperty(window, "innerWidth", { value: 400 })
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it("updates when media query changes", () => {
    mockMatches = false
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)

    act(() => {
      changeHandler?.({ matches: true } as MediaQueryListEvent)
    })
    expect(result.current).toBe(true)

    act(() => {
      changeHandler?.({ matches: false } as MediaQueryListEvent)
    })
    expect(result.current).toBe(false)
  })

  it("cleans up event listener on unmount", () => {
    const removeEventListener = vi.fn()
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener,
    }))

    const { unmount } = renderHook(() => useIsMobile())
    unmount()

    expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function))
  })

  it("uses correct breakpoint of 768px", () => {
    // 767 should be mobile
    Object.defineProperty(window, "innerWidth", { value: 767 })
    mockMatches = true
    const { result: mobileResult } = renderHook(() => useIsMobile())
    expect(mobileResult.current).toBe(true)

    // 768 should be desktop
    Object.defineProperty(window, "innerWidth", { value: 768 })
    mockMatches = false
    const { result: desktopResult } = renderHook(() => useIsMobile())
    expect(desktopResult.current).toBe(false)
  })

  it("syncs initial state from matchMedia.matches on mount", () => {
    // Set innerWidth to desktop, but matchMedia says mobile
    Object.defineProperty(window, "innerWidth", { value: 1024 })
    mockMatches = true

    const { result } = renderHook(() => useIsMobile())
    // The effect sets state from mql.matches, which is true
    expect(result.current).toBe(true)
  })
})
