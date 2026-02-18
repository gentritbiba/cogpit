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
      expect(result.current.config).toEqual(stored)
      expect(result.current.appliedConfig).toEqual(stored)
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

    it("defaults allowedTools and disallowedTools to empty arrays if not arrays", () => {
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

    it("persists to localStorage after change", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("acceptEdits"))

      const stored = JSON.parse(
        localStorage.getItem(PERMISSIONS_STORAGE_KEY)!
      )
      expect(stored.mode).toBe("acceptEdits")
    })

    it("marks pending changes when mode differs from applied", () => {
      const { result } = renderHook(() => usePermissions())

      expect(result.current.hasPendingChanges).toBe(false)
      act(() => result.current.setMode("plan"))
      expect(result.current.hasPendingChanges).toBe(true)
    })
  })

  describe("toggleAllowedTool", () => {
    it("adds a tool to allowedTools", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleAllowedTool("Read"))
      expect(result.current.config.allowedTools).toContain("Read")
    })

    it("removes a tool from allowedTools when toggled again", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleAllowedTool("Read"))
      expect(result.current.config.allowedTools).toContain("Read")

      act(() => result.current.toggleAllowedTool("Read"))
      expect(result.current.config.allowedTools).not.toContain("Read")
    })

    it("removes the tool from disallowedTools when adding to allowed", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleDisallowedTool("Bash"))
      expect(result.current.config.disallowedTools).toContain("Bash")

      act(() => result.current.toggleAllowedTool("Bash"))
      expect(result.current.config.allowedTools).toContain("Bash")
      expect(result.current.config.disallowedTools).not.toContain("Bash")
    })
  })

  describe("toggleDisallowedTool", () => {
    it("adds a tool to disallowedTools", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleDisallowedTool("Write"))
      expect(result.current.config.disallowedTools).toContain("Write")
    })

    it("removes a tool from disallowedTools when toggled again", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleDisallowedTool("Write"))
      act(() => result.current.toggleDisallowedTool("Write"))
      expect(result.current.config.disallowedTools).not.toContain("Write")
    })

    it("removes the tool from allowedTools when adding to disallowed", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.toggleAllowedTool("Edit"))
      expect(result.current.config.allowedTools).toContain("Edit")

      act(() => result.current.toggleDisallowedTool("Edit"))
      expect(result.current.config.disallowedTools).toContain("Edit")
      expect(result.current.config.allowedTools).not.toContain("Edit")
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

    it("marks pending changes if applied config differs from default", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      act(() => result.current.markApplied())
      expect(result.current.hasPendingChanges).toBe(false)

      act(() => result.current.resetToDefault())
      expect(result.current.hasPendingChanges).toBe(true)
    })
  })

  describe("localStorage persistence", () => {
    it("does not persist the initial load to localStorage", () => {
      const stored = {
        mode: "plan",
        allowedTools: [],
        disallowedTools: [],
      }
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify(stored))

      // Track setItem calls after initial setup
      const spy = vi.spyOn(Storage.prototype, "setItem")
      renderHook(() => usePermissions())

      // The initial useEffect should skip persisting (isInitial.current = true)
      expect(spy).not.toHaveBeenCalledWith(
        PERMISSIONS_STORAGE_KEY,
        expect.any(String)
      )
      spy.mockRestore()
    })
  })
})
