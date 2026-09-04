import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock("@/plugin-api", () => apiMocks)

import { __resetClickUpStoreForTest, saveClickUpToken, useClickUpMyTasks } from "../clickupStore"

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

describe("ClickUp store", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    __resetClickUpStoreForTest()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("stops polling while ClickUp needs setup, and starts over once a token is saved", async () => {
    apiMocks.authFetch.mockResolvedValue(
      jsonResponse(503, { error: "Add a ClickUp API token to view your tasks", code: "clickup_not_configured" }),
    )
    const { result, unmount } = renderHook(() => useClickUpMyTasks(true))

    await waitFor(() => {
      expect(result.current.error?.code).toBe("clickup_not_configured")
    })
    expect(apiMocks.authFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(apiMocks.authFetch).toHaveBeenCalledTimes(1)

    const tasks = { workspace: { id: "1", name: "W" }, viewer: { id: 7, username: "g", initials: "G", color: null }, tasks: [], truncated: false }
    apiMocks.authFetch.mockImplementation(async (url: string) => (
      url === "/api/clickup/tasks/mine"
        ? jsonResponse(200, tasks)
        : jsonResponse(200, { configured: true, tokenFromEnv: false, viewer: tasks.viewer, workspace: tasks.workspace })
    ))
    await act(async () => {
      await saveClickUpToken("pk_12345678_ABCDEFGHIJKLMNOP")
    })
    expect(result.current.error).toBeNull()
    expect(apiMocks.authFetch).toHaveBeenCalledWith(
      "/api/clickup/token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "pk_12345678_ABCDEFGHIJKLMNOP" }) }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    await waitFor(() => {
      expect(result.current.data).toEqual(tasks)
    })
    unmount()
  })
})
