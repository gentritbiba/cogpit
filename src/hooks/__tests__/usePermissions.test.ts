import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { usePermissions } from "@/hooks/usePermissions"
import {
  defaultPermissions,
  PERMISSIONS_STORAGE_KEY,
} from "@/lib/permissions"

const EARLIER_INSTALL_DEFAULTS = defaultPermissions(false)

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
  it("uses a supported mode immediately when switching providers", () => {
    const preference = { mode: "bypassPermissions", allowedTools: ["Read"], disallowedTools: ["Bash"] }
    localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify(preference))
    const { result, rerender } = renderHook(({ kind }) => usePermissions(kind), { initialProps: { kind: "claude" as "claude" | "acp" } })
    expect(result.current.config.mode).toBe("bypassPermissions")
    rerender({ kind: "acp" })
    expect(result.current.config.mode).toBe("default")
    expect(result.current.config.allowedTools).toEqual([])
    expect(result.current.config.disallowedTools).toEqual([])
    expect(result.current.hasPendingChanges).toBe(false)
    rerender({ kind: "claude" })
    expect(result.current.config.mode).toBe("bypassPermissions")
    expect(result.current.config).toEqual(preference)
    expect(JSON.parse(localStorage.getItem(PERMISSIONS_STORAGE_KEY)!)).toEqual(preference)
  })

  it("normalizes incompatible saved and hydrated modes for an ACP composer", () => {
    localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify({ mode: "plan" }))
    const { result } = renderHook(() => usePermissions("acp"))
    expect(result.current.config.mode).toBe("default")
    act(() => result.current.setMode("bypassPermissions"))
    expect(result.current.config.mode).toBe("default")
    expect(JSON.parse(localStorage.getItem(PERMISSIONS_STORAGE_KEY)!).mode).toBe("default")
    act(() => result.current.markApplied())
    expect(result.current.hasPendingChanges).toBe(false)
  })

  it("keeps a mode chosen for the next session's agent while another agent's session is open", () => {
    // Mission Control over a Codex session; the home composer starts Claude with Accept Edits.
    const { result, rerender } = renderHook(({ kind }) => usePermissions(kind), { initialProps: { kind: "codex" as "codex" | "claude" } })
    act(() => result.current.setModeFor("claude", "acceptEdits"))

    expect(result.current.modeFor("claude")).toBe("acceptEdits")
    expect(JSON.parse(localStorage.getItem(PERMISSIONS_STORAGE_KEY)!).mode).toBe("acceptEdits")
    // The open Codex session shows the closest mode it has, without changing the choice.
    expect(result.current.config.mode).toBe("default")
    expect(result.current.modeFor("codex")).toBe("default")

    rerender({ kind: "claude" })
    expect(result.current.config.mode).toBe("acceptEdits")
  })

  describe("initial state", () => {
    it("keeps an earlier install in full access when nothing is stored", () => {
      const { result } = renderHook(() => usePermissions())
      expect(result.current.config).toEqual(EARLIER_INSTALL_DEFAULTS)
      expect(result.current.config.mode).toBe("bypassPermissions")
      expect(result.current.hasPendingChanges).toBe(false)
    })

    it("starts a new install in each agent's ask-first mode", () => {
      for (const kind of ["claude", "codex", "copilot"] as const) {
        const { result } = renderHook(() => usePermissions(kind, true))
        expect(result.current.config.mode).toBe("default")
      }
    })

    it("follows the install once the server answers, without counting it a change", () => {
      const { result, rerender } = renderHook(({ fresh }) => usePermissions("claude", fresh), { initialProps: { fresh: false } })
      rerender({ fresh: true })
      expect(result.current.config.mode).toBe("default")
      expect(result.current.hasPendingChanges).toBe(false)
      expect(localStorage.getItem(PERMISSIONS_STORAGE_KEY)).toBeNull()
    })

    it("keeps a stored choice on a new install", () => {
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify({ mode: "bypassPermissions" }))
      const { result } = renderHook(() => usePermissions("claude", true))
      expect(result.current.config.mode).toBe("bypassPermissions")
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

    it("falls back to the install's defaults for malformed JSON", () => {
      localStorage.setItem(PERMISSIONS_STORAGE_KEY, "not-valid-json")

      const { result } = renderHook(() => usePermissions())
      expect(result.current.config).toEqual(EARLIER_INSTALL_DEFAULTS)
    })

    it("falls back to the install's defaults if stored object has no mode", () => {
      localStorage.setItem(
        PERMISSIONS_STORAGE_KEY,
        JSON.stringify({ allowedTools: ["Read"] })
      )

      const { result } = renderHook(() => usePermissions("claude", true))
      expect(result.current.config.mode).toBe("default")
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

  describe("markApplied", () => {
    it("clears pending changes", () => {
      const { result } = renderHook(() => usePermissions())

      act(() => result.current.setMode("plan"))
      expect(result.current.hasPendingChanges).toBe(true)

      act(() => result.current.markApplied())
      expect(result.current.hasPendingChanges).toBe(false)
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

    it("a fresh remote scope falls back to the defaults, not the local value", () => {
      // Local device has its own stored config...
      localStorage.setItem(
        PERMISSIONS_STORAGE_KEY,
        JSON.stringify({ mode: "plan", allowedTools: ["Bash"], disallowedTools: [] })
      )

      // ...but a never-seen remote device must start from the defaults.
      setPath("/d/dev_x/")
      const { result } = renderHook(() => usePermissions())

      expect(result.current.config).toEqual(EARLIER_INSTALL_DEFAULTS)
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
