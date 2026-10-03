import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

import { authFetch } from "@/lib/auth"
import { __resetSessionAccessForTest, knownSessionAccess, publishListsStale } from "@/lib/sessionAccess"
import type { ListFilter } from "@/lib/sessionListFilter"
import { usePullRequestSessionSearch } from "../usePullRequestSessionSearch"

const mockAuthFetch = vi.mocked(authFetch)
const UNFILTERED: ListFilter = { key: null, query: {} }

function response(body: unknown[], pending: number): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "X-Cogpit-PR-Index-Pending": String(pending) },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetSessionAccessForTest()
})

describe("usePullRequestSessionSearch", () => {
  it("leaves ordinary session searches local", () => {
    const { result } = renderHook(() => usePullRequestSessionSearch("fix checkout", UNFILTERED))

    expect(result.current.active).toBe(false)
    expect(result.current.loading).toBe(false)
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("polls while the durable index is catching up, then returns exact matches", async () => {
    const match = { sessionId: "session-157", matchedPullRequestNumber: 157 }
    mockAuthFetch
      .mockResolvedValueOnce(response([], 1))
      .mockResolvedValueOnce(response([match], 0))

    const { result } = renderHook(() => (
      usePullRequestSessionSearch<typeof match>("honest-cms #157", UNFILTERED, "-work-honest-cms")
    ))

    expect(result.current.active).toBe(true)
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.results).toEqual([match]), { timeout: 2_000 })

    expect(result.current.loading).toBe(false)
    expect(mockAuthFetch).toHaveBeenCalledTimes(2)
    expect(mockAuthFetch.mock.calls[0]?.[0]).toContain("search=honest-cms+%23157")
    expect(mockAuthFetch.mock.calls[0]?.[0]).toContain("project=-work-honest-cms")
  })

  it("learns the access of the sessions it finds", async () => {
    const access = { level: "interact" as const, mine: false }
    mockAuthFetch.mockResolvedValue(response([{ sessionId: "session-157", access }], 0))

    const { result } = renderHook(() => usePullRequestSessionSearch("#157", UNFILTERED))

    await waitFor(() => expect(result.current.results).toHaveLength(1), { timeout: 2_000 })
    expect(knownSessionAccess("session-157")).toBe("interact")
  })

  it("searches within the list filter", async () => {
    mockAuthFetch.mockResolvedValue(response([], 0))
    const narrow: ListFilter = { key: "narrow", query: { filter: "narrow" } }

    renderHook(() => usePullRequestSessionSearch("#157", narrow))

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled(), { timeout: 2_000 })
    expect(mockAuthFetch.mock.calls[0]?.[0]).toContain("filter=narrow")
  })

  it("searches again when the lists go stale", async () => {
    const access = { level: "view" as const, mine: false }
    const reassigned = { ...access, level: "own" as const, mine: true }
    mockAuthFetch
      .mockResolvedValueOnce(response([{ sessionId: "session-157", access }], 0))
      .mockResolvedValueOnce(response([{ sessionId: "session-157", access: reassigned }], 0))

    const { result } = renderHook(() => usePullRequestSessionSearch("#157", UNFILTERED))
    await waitFor(() => expect(result.current.results).toHaveLength(1), { timeout: 2_000 })

    act(() => publishListsStale())

    await waitFor(() => expect(result.current.results).toEqual([
      { sessionId: "session-157", access: reassigned },
    ]), { timeout: 2_000 })
    expect(mockAuthFetch).toHaveBeenCalledTimes(2)
  })
})
