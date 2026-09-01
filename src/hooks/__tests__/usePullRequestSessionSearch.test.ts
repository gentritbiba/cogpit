import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

import { authFetch } from "@/lib/auth"
import { usePullRequestSessionSearch } from "../usePullRequestSessionSearch"

const mockAuthFetch = vi.mocked(authFetch)

function response(body: unknown[], pending: number): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "X-Cogpit-PR-Index-Pending": String(pending) },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("usePullRequestSessionSearch", () => {
  it("leaves ordinary session searches local", () => {
    const { result } = renderHook(() => usePullRequestSessionSearch("fix checkout"))

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
      usePullRequestSessionSearch<typeof match>("honest-cms #157", "-work-honest-cms")
    ))

    expect(result.current.active).toBe(true)
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.results).toEqual([match]), { timeout: 2_000 })

    expect(result.current.loading).toBe(false)
    expect(mockAuthFetch).toHaveBeenCalledTimes(2)
    expect(mockAuthFetch.mock.calls[0]?.[0]).toContain("search=honest-cms+%23157")
    expect(mockAuthFetch.mock.calls[0]?.[0]).toContain("project=-work-honest-cms")
  })
})
