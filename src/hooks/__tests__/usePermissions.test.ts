import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { usePermissions } from "@/hooks/usePermissions"
import {
  DEFAULT_PERMISSIONS,
  PERMISSIONS_STORAGE_KEY,
} from "@/lib/permissions"

function setPath(pathname: string) {
  Object.defineProperty(window, "location", {
    value: { pathname },
    writable: true,
    configurable: true,
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  // Default to the local device unless a test opts into a remote scope.
  setPath("/")
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

    it("keeps a stored bypass mode (full access is a first-class choice)", () => {
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify({
        mode: "bypassPermissions",
        allowedTools: [],
        disallowedTools: [],
      }))

      const { result } = renderHook(() => usePermissions())

      expect(result.current.config.mode).toBe("bypassPermissions")
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

  // ── Per-device scoping ────────────────────────────────────────────────────
  describe("device scoping", () => {
    const REMOTE_KEY = `${PERMISSIONS_STORAGE_KEY}::dev_x`

    it("uses the unscoped key for the local device", () => {
      setPath("/")
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))

      expect(localStorage.getItem(PERMISSIONS_STORAGE_KEY)).not.toBeNull()
      expect(localStorage.getItem(REMOTE_KEY)).toBeNull()
    })

    it("a fresh remote scope falls back to DEFAULT_PERMISSIONS, not the local value", () => {
      // Local device has its own stored config...
      localStorage.setItem(
        PERMISSIONS_STORAGE_KEY,
        JSON.stringify({ mode: "plan", allowedTools: ["Bash"], disallowedTools: [] })
      )

      // ...but a never-seen remote device must start from the defaults.
      setPath("/d/dev_x/")
      const { result } = renderHook(() => usePermissions())

      expect(result.current.config).toEqual(DEFAULT_PERMISSIONS)
      // The fresh remote scope must not have been written from the local value.
      expect(localStorage.getItem(REMOTE_KEY)).toBeNull()
      // The local (unscoped) value is left untouched.
      expect(
        JSON.parse(localStorage.getItem(PERMISSIONS_STORAGE_KEY)!).mode
      ).toBe("plan")
    })

    it("persists remote-device changes under the scoped key only", () => {
      setPath("/d/dev_x/")
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))

      expect(JSON.parse(localStorage.getItem(REMOTE_KEY)!).mode).toBe("plan")
      expect(localStorage.getItem(PERMISSIONS_STORAGE_KEY)).toBeNull()
    })

    it("loads an existing remote scope independently of local", () => {
      localStorage.setItem(
        PERMISSIONS_STORAGE_KEY,
        JSON.stringify({ mode: "acceptEdits", allowedTools: [], disallowedTools: [] })
      )
      localStorage.setItem(
        REMOTE_KEY,
        JSON.stringify({ mode: "plan", allowedTools: ["Read"], disallowedTools: [] })
      )

      setPath("/d/dev_x/")
      const { result } = renderHook(() => usePermissions())

      expect(result.current.config.mode).toBe("plan")
      expect(result.current.config.allowedTools).toEqual(["Read"])
    })
  })
})
