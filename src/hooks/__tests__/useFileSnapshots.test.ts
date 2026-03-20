import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { useFileSnapshots } from "@/hooks/useFileSnapshots"
import { authFetch } from "@/lib/auth"
import { clearSnapshotCache } from "@/hooks/useFileSnapshots"

const mockAuthFetch = vi.mocked(authFetch)

beforeEach(() => {
  vi.clearAllMocks()
  clearSnapshotCache()
})

describe("useFileSnapshots", () => {
  it("returns loading state initially", () => {
    mockAuthFetch.mockImplementation(() => new Promise(() => {})) // never resolves
    const { result } = renderHook(() =>
      useFileSnapshots("session-123", "src/app.ts"),
    )
    expect(result.current.loading).toBe(true)
    expect(result.current.before).toBeNull()
    expect(result.current.after).toBeNull()
    expect(result.current.hasSnapshots).toBe(false)
  })

  it("fetches and returns snapshot data", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ before: "old code", after: "new code", versions: [1, 3] }),
        { status: 200 },
      ),
    )

    const { result } = renderHook(() =>
      useFileSnapshots("session-123", "src/app.ts"),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.before).toBe("old code")
    expect(result.current.after).toBe("new code")
    expect(result.current.hasSnapshots).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it("handles null response (no snapshots)", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      new Response("null", { status: 200 }),
    )

    const { result } = renderHook(() =>
      useFileSnapshots("session-123", "missing.ts"),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasSnapshots).toBe(false)
    expect(result.current.before).toBeNull()
    expect(result.current.after).toBeNull()
  })

  it("handles fetch errors gracefully", async () => {
    mockAuthFetch.mockRejectedValueOnce(new Error("Network error"))

    const { result } = renderHook(() =>
      useFileSnapshots("session-123", "src/app.ts"),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe("Network error")
    expect(result.current.hasSnapshots).toBe(false)
  })

  it("caches results for the same session+file", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ before: "old", after: "new", versions: [1, 2] }),
        { status: 200 },
      ),
    )

    const { result: r1 } = renderHook(() =>
      useFileSnapshots("session-123", "src/app.ts"),
    )
    await waitFor(() => expect(r1.current.loading).toBe(false))

    const { result: r2 } = renderHook(() =>
      useFileSnapshots("session-123", "src/app.ts"),
    )
    await waitFor(() => expect(r2.current.loading).toBe(false))

    // Only one fetch call — second was cached
    expect(mockAuthFetch).toHaveBeenCalledTimes(1)
  })

  it("does not fetch when sessionId or filePath is empty", () => {
    renderHook(() => useFileSnapshots("", "src/app.ts"))
    renderHook(() => useFileSnapshots("session-123", ""))
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })
})
