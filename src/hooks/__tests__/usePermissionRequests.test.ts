import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePermissionRequests, type PermissionRequest } from "../usePermissionRequests"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"

const mockedAuthFetch = vi.mocked(authFetch)

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

  it("keeps an already-pending approval visible when full access is selected", async () => {
    const { result, rerender } = renderHook(
      ({ permissionMode }) => usePermissionRequests("session-1", permissionMode),
      { initialProps: { permissionMode: "default" as string | undefined } },
    )

    await waitFor(() => {
      expect(result.current.requests).toEqual([pendingRequest])
    })

    rerender({ permissionMode: "bypassPermissions" })

    expect(result.current.requests).toEqual([pendingRequest])
    expect(mockedAuthFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/respond"),
      expect.anything(),
    )
  })

  it("still polls for pending approvals when a session already uses full access", async () => {
    const { result } = renderHook(() => (
      usePermissionRequests("session-1", "bypassPermissions")
    ))

    await waitFor(() => {
      expect(result.current.requests).toEqual([pendingRequest])
    })

    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/permissions/session-1")
  })
})
