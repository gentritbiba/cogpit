import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { usePermissions } from "@/hooks/usePermissions"
import {
  DEFAULT_PERMISSIONS,
  PERMISSIONS_STORAGE_KEY,
} from "@/lib/permissions"

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe("usePermissions", () => {
  describe("initial state", () => {
    it("returns DEFAULT_PERMISSIONS when localStorage is empty", () => {
      const { result } = renderHook(() => usePermissions())
      expect(result.current.config).toEqual(DEFAULT_PERMISSIONS)
      expect(result.current.appliedConfig).toEqual(DEFAULT_PERMISSIONS)
      expect(result.current.hasPendingChanges).toBe(false)
    })

    it("loads config from localStorage on mount", () => {
      const stored = {
        mode: "plan",
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      }
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify(stored))

      const { result } = renderHook(() => usePermissions())
      expect(result.current.config.mode).toBe("plan")
      expect(result.current.config.allowedTools).toEqual(["Read"])
      expect(result.current.config.disallowedTools).toEqual(["Bash"])
    })

    it("migrates the legacy bypass default to the safe workspace mode", () => {
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify({
        mode: "bypassPermissions",
        allowedTools: [],
        disallowedTools: [],
      }))

      const { result } = renderHook(() => usePermissions())

      expect(result.current.config.mode).toBe("default")
      expect(JSON.parse(localStorage.getItem(PERMISSIONS_STORAGE_KEY)!).mode).toBe("default")
    })

    it("falls back to DEFAULT_PERMISSIONS for malformed JSON", () => {
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, "not-valid-json")

      const { result } = renderHook(() => usePermissions())
      expect(result.current.config).toEqual(DEFAULT_PERMISSIONS)
    })

    it("falls back to DEFAULT_PERMISSIONS if stored object has no mode", () => {
      localStorage.setItem(
        PERMISSIONS_STORAGE_KEY,
        JSON.stringify({ allowedTools: ["Read"] })
      )

      const { result } = renderHook(() => usePermissions())
      expect(result.current.config.mode).toBe(DEFAULT_PERMISSIONS.mode)
    })

    it("defaults to empty arrays for invalid tool lists", () => {
      localStorage.setItem(
        PERMISSIONS_STORAGE_KEY,
        JSON.stringify({ mode: "plan", allowedTools: "bad", disallowedTools: null })
      )

      const { result } = renderHook(() => usePermissions())
      expect(result.current.config.allowedTools).toEqual([])
      expect(result.current.config.disallowedTools).toEqual([])
    })
  })

  describe("setMode", () => {
    it("changes the permission mode", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      expect(result.current.config.mode).toBe("plan")
    })

    it("marks pending changes when mode differs from applied", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      expect(result.current.hasPendingChanges).toBe(true)
    })

    it("persists mode changes to localStorage", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("acceptEdits"))

      const stored = JSON.parse(localStorage.getItem(PERMISSIONS_STORAGE_KEY)!)
      expect(stored.mode).toBe("acceptEdits")
    })
  })

  describe("toggleAllowedTool", () => {
    it("adds a tool to allowedTools", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleAllowedTool("Read"))
      expect(result.current.config.allowedTools).toEqual(["Read"])
    })

    it("removes a tool when toggled again", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleAllowedTool("Read"))
      act(() => result.current.toggleAllowedTool("Read"))
      expect(result.current.config.allowedTools).toEqual([])
    })
  })

  describe("toggleDisallowedTool", () => {
    it("adds a tool to disallowedTools", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleDisallowedTool("Write"))
      expect(result.current.config.disallowedTools).toEqual(["Write"])
    })

    it("removes a tool when toggled again", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleDisallowedTool("Write"))
      act(() => result.current.toggleDisallowedTool("Write"))
      expect(result.current.config.disallowedTools).toEqual([])
    })
  })

  describe("markApplied", () => {
    it("syncs appliedConfig with config and clears pending changes", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      expect(result.current.hasPendingChanges).toBe(true)

      act(() => result.current.markApplied())
      expect(result.current.hasPendingChanges).toBe(false)
      expect(result.current.appliedConfig.mode).toBe("plan")
    })
  })

  describe("resetToDefault", () => {
    it("resets config to DEFAULT_PERMISSIONS", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("dontAsk"))
      act(() => result.current.toggleAllowedTool("Read"))
      act(() => result.current.toggleDisallowedTool("Bash"))

      act(() => result.current.resetToDefault())
      expect(result.current.config).toEqual(DEFAULT_PERMISSIONS)
    })

    it("clears pending changes after reset when applied was default", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      expect(result.current.hasPendingChanges).toBe(true)

      act(() => result.current.resetToDefault())
      expect(result.current.hasPendingChanges).toBe(false)
    })
  })

  describe("localStorage persistence", () => {
    it("persists config changes to localStorage", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      act(() => result.current.toggleAllowedTool("Read"))

      const stored = JSON.parse(localStorage.getItem(PERMISSIONS_STORAGE_KEY)!)
      expect(stored.mode).toBe("plan")
      expect(stored.allowedTools).toEqual(["Read"])
    })
  })
})
