import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePermissionRequests, type PermissionRequest } from "../usePermissionRequests"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  jsonFetch: vi.fn(),
}))

import { authFetch, jsonFetch } from "@/lib/auth"

const mockedAuthFetch = vi.mocked(authFetch)
const mockedJsonFetch = vi.mocked(jsonFetch)

const pendingRequest: PermissionRequest = {
  requestId: "approval-1",
  toolName: "Bash",
  input: { command: "git status" },
  toolUseId: "tool-1",
  timestamp: 1_800_000_000,
}

describe("usePermissionRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: [pendingRequest] }),
    } as Response)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    })
  })

  it("keeps an already-pending approval visible across re-renders", async () => {
    const { result, rerender } = renderHook(() => usePermissionRequests("session-1"))

    await waitFor(() => {
      expect(result.current.requests).toEqual([pendingRequest])
    })

    rerender()

    expect(result.current.requests).toEqual([pendingRequest])
    expect(mockedJsonFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/respond"),
      expect.anything(),
    )
  })

  it("still polls for pending approvals when a session already uses full access", async () => {
    const { result } = renderHook(() => usePermissionRequests("session-1"))

    await waitFor(() => {
      expect(result.current.requests).toEqual([pendingRequest])
    })

    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/permissions/session-1")
  })

  it("preserves the requests reference when a poll returns unchanged data", async () => {
    let poll: (() => void) | null = null
    const originalSetInterval = globalThis.setInterval
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler, timeout, ...args) => {
      if (timeout === 2_000) {
        poll = handler as () => void
        return 1 as unknown as ReturnType<typeof setInterval>
      }
      return originalSetInterval(handler, timeout, ...args)
    })

    const { result, unmount } = renderHook(() => (
      usePermissionRequests("session-1")
    ))

    await waitFor(() => expect(result.current.requests).toEqual([pendingRequest]))
    const firstRequests = result.current.requests

    await act(async () => {
      poll?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledTimes(2))

    expect(result.current.requests).toBe(firstRequests)
    unmount()
  })

  it("does not poll while the document is hidden and refreshes when visible", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    })

    const { result, unmount } = renderHook(() => (
      usePermissionRequests("session-1")
    ))

    await act(async () => { await Promise.resolve() })
    expect(mockedAuthFetch).not.toHaveBeenCalled()
    expect(result.current.requests).toEqual([])

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    })
    document.dispatchEvent(new Event("visibilitychange"))

    await waitFor(() => expect(result.current.requests).toEqual([pendingRequest]))

    unmount()
  })
})
