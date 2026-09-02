import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock("@/plugin-api", () => apiMocks)

import {
  __resetVercelDeploymentsStoreForTest,
  useVercelDeployments,
} from "../vercelDeploymentsStore"

describe("Vercel deployments store", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiMocks.authFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: "Update Vercel CLI to version 50.5.1 or newer to view deployments safely",
        code: "vercel_cli_too_old",
      }),
    })
  })

  afterEach(() => {
    __resetVercelDeploymentsStoreForTest()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("does not poll repeatedly while Vercel CLI needs setup", async () => {
    const { result, unmount } = renderHook(() => useVercelDeployments("/repo", true))

    await waitFor(() => {
      expect(result.current.error?.code).toBe("vercel_cli_too_old")
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
