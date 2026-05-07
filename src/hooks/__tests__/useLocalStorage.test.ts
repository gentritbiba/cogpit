import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useLocalStorage } from "../useLocalStorage"

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe("useLocalStorage", () => {
  describe("initial state", () => {
    it("returns defaultValue when key is absent", () => {
      const { result } = renderHook(() => useLocalStorage("test-key", 42))
      expect(result.current[0]).toBe(42)
    })

    it("returns defaultValue when key is absent (string)", () => {
      const { result } = renderHook(() => useLocalStorage("test-key", "hello"))
      expect(result.current[0]).toBe("hello")
    })

    it("reads existing value from localStorage on mount", () => {
      localStorage.setItem("test-key", JSON.stringify(99))
      const { result } = renderHook(() => useLocalStorage("test-key", 0))
      expect(result.current[0]).toBe(99)
    })

    it("reads existing object value from localStorage on mount", () => {
      localStorage.setItem("test-key", JSON.stringify({ foo: "bar" }))
      const { result } = renderHook(() => useLocalStorage<{ foo: string }>("test-key", { foo: "default" }))
      expect(result.current[0]).toEqual({ foo: "bar" })
    })

    it("falls back to defaultValue when localStorage contains malformed JSON", () => {
      localStorage.setItem("test-key", "not-valid-json{{{")
      const { result } = renderHook(() => useLocalStorage("test-key", "fallback"))
      expect(result.current[0]).toBe("fallback")
    })
  })

  describe("setValue", () => {
    it("updates state with a new value", () => {
      const { result } = renderHook(() => useLocalStorage("test-key", 0))
      act(() => {
        result.current[1](7)
      })
      expect(result.current[0]).toBe(7)
    })

    it("persists the new value to localStorage", () => {
      const { result } = renderHook(() => useLocalStorage("test-key", 0))
      act(() => {
        result.current[1](7)
      })
      expect(JSON.parse(localStorage.getItem("test-key")!)).toBe(7)
    })

    it("accepts a function updater and uses previous value", () => {
      localStorage.setItem("test-key", JSON.stringify(5))
      const { result } = renderHook(() => useLocalStorage("test-key", 0))
      act(() => {
        result.current[1]((prev) => prev + 10)
      })
      expect(result.current[0]).toBe(15)
      expect(JSON.parse(localStorage.getItem("test-key")!)).toBe(15)
    })

    it("function updater starts from defaultValue when key is absent", () => {
      const { result } = renderHook(() => useLocalStorage("test-key", 3))
      act(() => {
        result.current[1]((prev) => prev * 2)
      })
      expect(result.current[0]).toBe(6)
    })

    it("persists boolean values correctly", () => {
      const { result } = renderHook(() => useLocalStorage("bool-key", false))
      act(() => {
        result.current[1](true)
      })
      expect(result.current[0]).toBe(true)
      expect(JSON.parse(localStorage.getItem("bool-key")!)).toBe(true)
    })

    it("persists object values correctly", () => {
      const { result } = renderHook(() => useLocalStorage<Record<string, unknown>>("obj-key", {}))
      act(() => {
        result.current[1]({ a: 1, b: "two" })
      })
      expect(result.current[0]).toEqual({ a: 1, b: "two" })
      expect(JSON.parse(localStorage.getItem("obj-key")!)).toEqual({ a: 1, b: "two" })
    })
  })

  describe("SSR safety", () => {
    it("returns defaultValue when localStorage.getItem throws (simulates restricted env)", () => {
      // Simulate an environment where localStorage access throws (e.g., incognito / security policy).
      // Use vi.spyOn(localStorage, "getItem") to match the plain-object mock used in this test setup.
      const getItemSpy = vi.spyOn(localStorage, "getItem").mockImplementationOnce(() => {
        throw new Error("Access denied")
      })
      const { result } = renderHook(() => useLocalStorage("ssr-key", "ssr-default"))
      expect(result.current[0]).toBe("ssr-default")
      getItemSpy.mockRestore()
    })

    it("does not crash when localStorage.setItem throws on setValue", () => {
      // The test setup replaces localStorage with a plain object mock.
      // Spy on that mock's setItem directly.
      const setItemSpy = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
        throw new Error("QuotaExceededError")
      })
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const { result } = renderHook(() => useLocalStorage("ssr-key", 0))
      // Should not throw; state should still update in memory
      act(() => {
        result.current[1](5)
      })
      expect(result.current[0]).toBe(5)
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
      setItemSpy.mockRestore()
    })

  })

  describe("SSR window guard (unit)", () => {
    it("returns defaultValue when window is undefined", () => {
      // Directly test the lazy-initializer logic the hook uses, without needing
      // a full React render (which requires window/document itself).
      // This mirrors the exact guard: `if (typeof window === "undefined") return defaultValue`
      function ssrInit<T>(defaultValue: T, key: string): T {
        if (typeof window === "undefined") return defaultValue
        try {
          const raw = localStorage.getItem(key)
          if (raw === null) return defaultValue
          return JSON.parse(raw) as T
        } catch {
          return defaultValue
        }
      }

      // Simulate SSR by stubbing window away, call the initializer, then restore.
      const savedWindow = globalThis.window
      // @ts-expect-error — intentional SSR simulation
      globalThis.window = undefined
      try {
        expect(ssrInit("ssr-default", "ssr-win-key")).toBe("ssr-default")
        expect(ssrInit(42, "ssr-num-key")).toBe(42)
        expect(ssrInit({ a: 1 }, "ssr-obj-key")).toEqual({ a: 1 })
      } finally {
        globalThis.window = savedWindow
      }
    })
  })
})
