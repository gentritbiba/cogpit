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

    it("ignores config from localStorage on mount", () => {
      const stored = {
        mode: "plan",
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      }
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify(stored))

      const { result } = renderHook(() => usePermissions())
      expect(result.current.config).toEqual(DEFAULT_PERMISSIONS)
      expect(result.current.appliedConfig).toEqual(DEFAULT_PERMISSIONS)
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
      expect(result.current.config).toEqual(DEFAULT_PERMISSIONS)
    })

    it("always returns default empty tool lists", () => {
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
    it("does not change the permission mode", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      expect(result.current.config.mode).toBe("bypassPermissions")
    })

    it("does not persist mode changes to localStorage", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("acceptEdits"))

      expect(localStorage.getItem(PERMISSIONS_STORAGE_KEY)).toBeNull()
    })

    it("never marks pending changes", () => {
      const { result } = renderHook(() => usePermissions())

      expect(result.current.hasPendingChanges).toBe(false)
      act(() => result.current.setMode("plan"))
      expect(result.current.hasPendingChanges).toBe(false)
    })
  })

  describe("toggleAllowedTool", () => {
    it("does not add a tool to allowedTools", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleAllowedTool("Read"))
      expect(result.current.config.allowedTools).toEqual([])
    })

    it("keeps allowedTools empty when toggled repeatedly", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleAllowedTool("Read"))
      act(() => result.current.toggleAllowedTool("Read"))
      expect(result.current.config.allowedTools).toEqual([])
    })

    it("does not move tools between lists", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleDisallowedTool("Bash"))
      act(() => result.current.toggleAllowedTool("Bash"))
      expect(result.current.config.allowedTools).toEqual([])
      expect(result.current.config.disallowedTools).toEqual([])
    })
  })

  describe("toggleDisallowedTool", () => {
    it("does not add a tool to disallowedTools", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleDisallowedTool("Write"))
      expect(result.current.config.disallowedTools).toEqual([])
    })

    it("keeps disallowedTools empty when toggled repeatedly", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleDisallowedTool("Write"))
      act(() => result.current.toggleDisallowedTool("Write"))
      expect(result.current.config.disallowedTools).toEqual([])
    })

    it("does not move tools from allowed to disallowed", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleAllowedTool("Edit"))
      act(() => result.current.toggleDisallowedTool("Edit"))
      expect(result.current.config.allowedTools).toEqual([])
      expect(result.current.config.disallowedTools).toEqual([])
    })
  })

  describe("markApplied", () => {
    it("syncs appliedConfig with config and clears pending changes", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      expect(result.current.hasPendingChanges).toBe(false)

      act(() => result.current.markApplied())
      expect(result.current.hasPendingChanges).toBe(false)
      expect(result.current.appliedConfig).toEqual(DEFAULT_PERMISSIONS)
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

    it("keeps pending changes false after reset", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      act(() => result.current.markApplied())
      expect(result.current.hasPendingChanges).toBe(false)

      act(() => result.current.resetToDefault())
      expect(result.current.hasPendingChanges).toBe(false)
    })
  })

  describe("localStorage persistence", () => {
    it("clears any stored permission config on mount", () => {
      const stored = {
        mode: "plan",
        allowedTools: [],
        disallowedTools: [],
      }
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify(stored))
      renderHook(() => usePermissions())
      expect(localStorage.getItem(PERMISSIONS_STORAGE_KEY)).toBeNull()
    })
  })
})
