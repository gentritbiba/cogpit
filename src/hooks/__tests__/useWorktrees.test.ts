import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { useWorktrees } from "../useWorktrees"

const mockedAuthFetch = vi.mocked(authFetch)

describe("useWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fetches worktrees for a dirName", async () => {
    const mockWorktrees = [
      { name: "fix-auth", branch: "worktree-fix-auth", isDirty: true, commitsAhead: 2 },
    ]

    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockWorktrees),
    } as unknown as Response)

    const { result } = renderHook(() => useWorktrees("my-project"))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.worktrees).toEqual(mockWorktrees)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("returns empty array when dirName is null", () => {
    const { result } = renderHook(() => useWorktrees(null))
    expect(result.current.worktrees).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it("calls the correct API endpoint with encoded dirName", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    } as unknown as Response)

    renderHook(() => useWorktrees("my-project"))

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/worktrees/my-project")
  })

  it("sets error when response is not ok", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
    } as unknown as Response)

    const { result } = renderHook(() => useWorktrees("my-project"))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.error).toBe("Failed to fetch worktrees")
    expect(result.current.loading).toBe(false)
  })

  it("sets error when fetch throws", async () => {
    mockedAuthFetch.mockRejectedValueOnce(new Error("Network error"))

    const { result } = renderHook(() => useWorktrees("my-project"))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.error).toBe("Network error")
    expect(result.current.loading).toBe(false)
  })

  it("polls every 30 seconds", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    } as unknown as Response)

    renderHook(() => useWorktrees("my-project"))

    // Wait for initial fetch
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)

    // Advance 30 seconds to trigger second fetch
    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })

    expect(mockedAuthFetch).toHaveBeenCalledTimes(2)

    // Advance another 30 seconds for a third fetch
    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })

    expect(mockedAuthFetch).toHaveBeenCalledTimes(3)
  })

  it("clears interval and resets worktrees when dirName becomes null", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ name: "fix-auth" }]),
    } as unknown as Response)

    const { result, rerender } = renderHook(
      (props: { dirName: string | null }) => useWorktrees(props.dirName),
      { initialProps: { dirName: "my-project" as string | null } }
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.worktrees).toHaveLength(1)

    rerender({ dirName: null })

    expect(result.current.worktrees).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it("ignores a stale response after the project changes", async () => {
    let resolveFirst!: (response: Response) => void
    let resolveSecond!: (response: Response) => void
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const secondResponse = new Promise<Response>((resolve) => { resolveSecond = resolve })
    mockedAuthFetch
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse)

    const { result, rerender } = renderHook(
      (props: { dirName: string }) => useWorktrees(props.dirName),
      { initialProps: { dirName: "project-a" } },
    )

    rerender({ dirName: "project-b" })
    expect(result.current.worktrees).toEqual([])
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveSecond({
        ok: true,
        json: () => Promise.resolve([{ name: "project-b-worktree" }]),
      } as unknown as Response)
      await secondResponse
    })

    expect(result.current.worktrees).toEqual([{ name: "project-b-worktree" }])

    await act(async () => {
      resolveFirst({
        ok: true,
        json: () => Promise.resolve([{ name: "stale-project-a-worktree" }]),
      } as unknown as Response)
      await firstResponse
    })

    expect(result.current.worktrees).toEqual([{ name: "project-b-worktree" }])
  })

  it("refetch function triggers a new fetch", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    } as unknown as Response)

    const { result } = renderHook(() => useWorktrees("my-project"))

    // Wait for initial fetch
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)

    // Call refetch
    await act(async () => {
      await result.current.refetch()
    })

    expect(mockedAuthFetch).toHaveBeenCalledTimes(2)
  })

  it("does not fetch when dirName is null even after refetch", async () => {
    const { result } = renderHook(() => useWorktrees(null))

    await act(async () => {
      await result.current.refetch()
    })

    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("clears interval on unmount", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    } as unknown as Response)

    const { unmount } = renderHook(() => useWorktrees("my-project"))

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)

    unmount()

    // Advance time — no more fetches should happen
    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
  })
})
