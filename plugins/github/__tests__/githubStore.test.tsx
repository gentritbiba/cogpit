import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = { request: vi.fn() }

import {
  createGitHubStore, GitHubStoreProvider, type GitHubStore,
  useGitHubActions,
  useGitHubPulls,
  useGitHubPullSessions,
} from "../githubStore"

let store: GitHubStore
const wrapper = ({ children }: { children: ReactNode }) => createElement(GitHubStoreProvider, { value: store }, children)
function hook<T>(callback: () => T) { return renderHook(callback, { wrapper }) }

describe("GitHub store", () => {
  beforeEach(() => {
    store = createGitHubStore({ integrations: apiMocks })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiMocks.request.mockResolvedValue({
      ok: false,
      error: {
        message: "Install the GitHub CLI to view workflow runs",
        code: "gh_missing",
      },
    })
  })

  afterEach(() => {
    store.dispose()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("does not poll repeatedly while GitHub CLI is missing", async () => {
    const { result, unmount } = hook(() => useGitHubActions("/repo", true))

    await waitFor(() => {
      expect(result.current.error?.code).toBe("gh_missing")
    })
    expect(apiMocks.request).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiMocks.request).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh()
    })
    expect(apiMocks.request).toHaveBeenCalledTimes(2)
    unmount()
  })

  it("stops ordinary and pending-session polling while its host panel is hidden", async () => {
    apiMocks.request.mockImplementation(async (input: { operation: string }) => ({ ok: true, data: input.operation === "pullSessions" ? { repository: "acme/app", sessions: [], pending: 1 } : { repository: "acme/app", runs: [] } }))
    const { rerender, unmount } = renderHook(({ visible }) => ({ runs: useGitHubActions("opaque-project", visible), sessions: useGitHubPullSessions("opaque-project", visible) }), { initialProps: { visible: true }, wrapper })
    await waitFor(() => expect(apiMocks.request).toHaveBeenCalledTimes(2))
    rerender({ visible: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(65000) })
    expect(apiMocks.request).toHaveBeenCalledTimes(2)
    unmount()
  })

  it("aborts pending detail/list requests on disposal and gives the next frame a separate cache", async () => {
    let finish!: (value: unknown) => void
    apiMocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const { result, unmount } = hook(() => useGitHubActions("opaque-project", true))
    const signal = apiMocks.request.mock.calls[0][1].signal as AbortSignal
    store.dispose()
    expect(signal.aborted).toBe(true)
    await act(async () => { finish({ ok: true, data: { repository: "old-host", runs: [] } }); await Promise.resolve() })
    expect(result.current.data).toBeNull()
    unmount()
    store = createGitHubStore({ integrations: apiMocks })
    apiMocks.request.mockResolvedValue({ ok: true, data: { repository: "next-host", runs: [] } })
    const next = hook(() => useGitHubActions("opaque-project", true))
    await waitFor(() => expect(next.result.current.data?.repository).toBe("next-host"))
    expect(apiMocks.request.mock.calls.at(-1)?.[0]).toEqual({ integration: "github", operation: "actions", limit: 20 })
    next.unmount()
  })

  it("keeps workflow runs and pull requests in separate caches", async () => {
    apiMocks.request.mockImplementation(async (input: { operation: string }) => ({
      ok: true,
      data: input.operation === "pulls"
        ? { repository: "acme/app", repositoryUrl: "https://github.com/acme/app", branch: "main", pulls: [] }
        : { repository: "acme/app", repositoryUrl: "https://github.com/acme/app", branch: "main", runs: [] },
    }))
    const { result, unmount } = hook(() => ({
      runs: useGitHubActions("/repo", true),
      pulls: useGitHubPulls("/repo", true),
    }))

    await waitFor(() => {
      expect(result.current.runs.data?.runs).toEqual([])
      expect(result.current.pulls.data?.pulls).toEqual([])
    })
    expect(apiMocks.request).toHaveBeenCalledTimes(2)
    expect(apiMocks.request).toHaveBeenCalledWith({ integration: "github", operation: "actions", limit: 20 }, { signal: expect.any(AbortSignal) })
    expect(apiMocks.request).toHaveBeenCalledWith({ integration: "github", operation: "pulls", limit: 30 }, { signal: expect.any(AbortSignal) })
    unmount()
  })

  /**
   * Resolves each `authFetch` only when the test says so, which is the only way
   * to observe the state a background poll publishes *while* it is in flight.
   */
  function deferredFetch(response: unknown) {
    const pending: Array<(value: unknown) => void> = []
    apiMocks.request.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    )
    return {
      calls: () => pending.length,
      settle: async (ok = true) => {
        const resolvers = pending.splice(0, pending.length)
        await act(async () => {
          for (const resolve of resolvers) {
            resolve(ok ? { ok, data: response } : { ok, error: { code: "github_api_failed", message: "GitHub is unreachable" } })
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
    const { result, unmount } = hook(() => useGitHubActions("/repo", true))

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
    const { result, unmount } = hook(() => useGitHubActions("/repo", true))

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
    const { result, unmount } = hook(() => useGitHubActions("/repo", true))

    await fetches.settle(false)
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

    await fetches.settle(false)
    unmount()
  })
})
