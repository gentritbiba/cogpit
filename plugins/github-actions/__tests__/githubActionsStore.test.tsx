import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock("@/plugin-api", () => apiMocks)

import {
  __resetGitHubActionsStoreForTest,
  useGitHubActions,
} from "../githubActionsStore"

describe("GitHub Actions store", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiMocks.authFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: "Install the GitHub CLI to view workflow runs",
        code: "gh_missing",
      }),
    })
  })

  afterEach(() => {
    __resetGitHubActionsStoreForTest()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("does not poll repeatedly while GitHub CLI is missing", async () => {
    const { result, unmount } = renderHook(() => useGitHubActions("/repo", true))

    await waitFor(() => {
      expect(result.current.error?.code).toBe("gh_missing")
    })
    expect(apiMocks.authFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiMocks.authFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh()
    })
    expect(apiMocks.authFetch).toHaveBeenCalledTimes(2)
    unmount()
  })
})
