import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { useLeakMonitor } from "../useLeakMonitor"

const mockedAuthFetch = vi.mocked(authFetch)

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

const LEAK = {
  pid: 42,
  kind: "headless-browser",
  label: "Headless Chrome",
  command: "chrome-headless-shell --type=renderer",
  cpuPercent: 55,
  memoryMb: 150,
  ageSeconds: 7200,
  orphaned: false,
  suspectedLeak: true,
}

const CLEAN_PROCESS = { ...LEAK, pid: 43, cpuPercent: 1, suspectedLeak: false }

describe("useLeakMonitor", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("fetches on mount and keeps only suspected leaks", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse({
      processes: [LEAK, CLEAN_PROCESS],
      suspectedLeakCount: 1,
      recentlyReaped: [],
    }))

    const { result } = renderHook(() => useLeakMonitor())

    await waitFor(() => expect(result.current.leaks).toHaveLength(1))
    expect(result.current.leaks[0].pid).toBe(42)
    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/system-processes")
  })

  it("killLeaks posts the pids then refreshes", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse({
      processes: [LEAK],
      suspectedLeakCount: 1,
      recentlyReaped: [],
    }))

    const { result } = renderHook(() => useLeakMonitor())
    await waitFor(() => expect(result.current.leaks).toHaveLength(1))

    mockedAuthFetch.mockResolvedValue(jsonResponse({
      processes: [],
      suspectedLeakCount: 0,
      recentlyReaped: [],
    }))
    // The kill endpoint response is also consumed via this mock; both calls resolve.
    await act(async () => {
      await result.current.killLeaks([42])
    })

    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/system-processes/kill", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ pids: [42] }),
    }))
    expect(result.current.leaks).toHaveLength(0)
    expect(result.current.killing).toBe(false)
  })

  it("does nothing when killLeaks is called with no pids", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse({
      processes: [],
      suspectedLeakCount: 0,
      recentlyReaped: [],
    }))

    const { result } = renderHook(() => useLeakMonitor())
    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalled())
    const callsAfterMount = mockedAuthFetch.mock.calls.length

    await act(async () => {
      await result.current.killLeaks([])
    })
    expect(mockedAuthFetch.mock.calls.length).toBe(callsAfterMount)
  })
})
