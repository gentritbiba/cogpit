import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock("@/plugin-api", () => apiMocks)

import {
  __resetGitHubStoreForTest,
  useGitHubActions,
  useGitHubPulls,
} from "../githubStore"

describe("GitHub store", () => {
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
    __resetGitHubStoreForTest()
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

  it("keeps workflow runs and pull requests in separate caches", async () => {
    apiMocks.authFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url.includes("/pulls")
        ? { repository: "acme/app", repositoryUrl: "https://github.com/acme/app", branch: "main", pulls: [] }
        : { repository: "acme/app", repositoryUrl: "https://github.com/acme/app", branch: "main", runs: [] },
    }))
    const { result, unmount } = renderHook(() => ({
      runs: useGitHubActions("/repo", true),
      pulls: useGitHubPulls("/repo", true),
    }))

    await waitFor(() => {
      expect(result.current.runs.data?.runs).toEqual([])
      expect(result.current.pulls.data?.pulls).toEqual([])
    })
    expect(apiMocks.authFetch).toHaveBeenCalledTimes(2)
    expect(apiMocks.authFetch).toHaveBeenCalledWith("/api/github/actions?cwd=%2Frepo&limit=20")
    expect(apiMocks.authFetch).toHaveBeenCalledWith("/api/github/pulls?cwd=%2Frepo&limit=30")
    unmount()
  })

  /**
   * Resolves each `authFetch` only when the test says so, which is the only way
   * to observe the state a background poll publishes *while* it is in flight.
   */
  function deferredFetch(response: unknown) {
    const pending: Array<(value: unknown) => void> = []
    apiMocks.authFetch.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    )
    return {
      calls: () => pending.length,
      settle: async (ok = true, status = 200) => {
        const resolvers = pending.splice(0, pending.length)
        await act(async () => {
          for (const resolve of resolvers) {
            resolve({ ok, status, json: async () => response })
          }
          await Promise.resolve()
        })
      },
    }
  }

  it("keeps a background poll invisible to the refresh button", async () => {
    const fetches = deferredFetch({
      repository: "acme/app",
      repositoryUrl: "https://github.com/acme/app",
      branch: "main",
      runs: [],
    })
    const { result, unmount } = renderHook(() => useGitHubActions("/repo", true))

    await fetches.settle()
    await waitFor(() => {
      expect(result.current.data?.runs).toEqual([])
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetches.calls()).toBe(1)
    // In flight: a user-invisible poll must not spin or disable the button.
    expect(result.current.refreshing).toBe(false)

    await fetches.settle()
    unmount()
  })

  it("shows the spinner for a user-requested refresh", async () => {
    const fetches = deferredFetch({
      repository: "acme/app",
      repositoryUrl: "https://github.com/acme/app",
      branch: "main",
      runs: [],
    })
    const { result, unmount } = renderHook(() => useGitHubActions("/repo", true))

    await fetches.settle()
    await waitFor(() => {
      expect(result.current.data?.runs).toEqual([])
    })

    act(() => { void result.current.refresh() })
    expect(result.current.refreshing).toBe(true)

    await fetches.settle()
    await waitFor(() => {
      expect(result.current.refreshing).toBe(false)
    })
    unmount()
  })

  it("keeps a standing error on screen while a background poll retries", async () => {
    const fetches = deferredFetch({ error: "GitHub is unreachable", code: "github_api_failed" })
    const { result, unmount } = renderHook(() => useGitHubActions("/repo", true))

    await fetches.settle(false, 500)
    await waitFor(() => {
      expect(result.current.error?.code).toBe("github_api_failed")
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetches.calls()).toBe(1)
    // In flight: clearing the error here would cycle the alert to a skeleton
    // and back on every interval.
    expect(result.current.error?.code).toBe("github_api_failed")

    await fetches.settle(false, 500)
    unmount()
  })
})
