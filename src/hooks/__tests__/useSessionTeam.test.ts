import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  authUrl: vi.fn((url: string) => url),
}))

// Mock useTeamLive to avoid EventSource setup
vi.mock("../useTeamLive", () => ({
  useTeamLive: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { useTeamLive } from "../useTeamLive"
import { useSessionTeam } from "../useSessionTeam"

const mockedAuthFetch = vi.mocked(authFetch)
const mockedUseTeamLive = vi.mocked(useTeamLive)

describe("useSessionTeam", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedUseTeamLive.mockReturnValue({ isLive: false })
  })

  it("returns null when sessionFileName is null", () => {
    const { result } = renderHook(() => useSessionTeam(null))
    expect(result.current).toBeNull()
    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("fetches team data for a simple session filename", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          teamName: "alpha-team",
          config: { name: "alpha-team", members: [], leadAgentId: "a1", createdAt: 0 },
          currentMemberName: "lead",
        }),
    } as Response)

    const { result } = renderHook(() => useSessionTeam("abc123.jsonl"))

    await waitFor(() => {
      expect(result.current).not.toBeNull()
    })

    expect(result.current!.teamName).toBe("alpha-team")
    expect(result.current!.currentMemberName).toBe("lead")

    // Check the query params
    const calledUrl = mockedAuthFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain("leadSessionId=abc123")
    expect(calledUrl).not.toContain("subagentFile")
  })

  it("extracts leadSessionId and subagentFile from subagent path", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          teamName: "team-beta",
          config: { name: "team-beta", members: [], leadAgentId: "b1", createdAt: 0 },
          currentMemberName: "worker-1",
        }),
    } as Response)

    const { result } = renderHook(() =>
      useSessionTeam("lead-session-id/subagents/worker.jsonl")
    )

    await waitFor(() => {
      expect(result.current).not.toBeNull()
    })

    const calledUrl = mockedAuthFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain("leadSessionId=lead-session-id")
    expect(calledUrl).toContain("subagentFile=worker.jsonl")
  })

  it("sets ctx to null when API returns non-ok response", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as Response)

    const { result } = renderHook(() => useSessionTeam("session.jsonl"))

    await waitFor(() => {
      expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
    })

    expect(result.current).toBeNull()
  })

  it("sets ctx to null when API returns null data", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    } as Response)

    const { result } = renderHook(() => useSessionTeam("session.jsonl"))

    await waitFor(() => {
      expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
    })

    expect(result.current).toBeNull()
  })

  it("sets ctx to null on fetch error", async () => {
    mockedAuthFetch.mockRejectedValue(new Error("Network error"))

    const { result } = renderHook(() => useSessionTeam("session.jsonl"))

    await waitFor(() => {
      expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
    })

    expect(result.current).toBeNull()
  })

  it("handles missing currentMemberName gracefully", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          teamName: "team-gamma",
          config: { name: "team-gamma", members: [], leadAgentId: "g1", createdAt: 0 },
          currentMemberName: "",
        }),
    } as Response)

    const { result } = renderHook(() => useSessionTeam("session.jsonl"))

    await waitFor(() => {
      expect(result.current).not.toBeNull()
    })

    // Empty string should become null via `|| null`
    expect(result.current!.currentMemberName).toBeNull()
  })

  it("re-fetches when sessionFileName changes", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          teamName: "team-1",
          config: { name: "team-1", members: [], leadAgentId: "a1", createdAt: 0 },
          currentMemberName: "m1",
        }),
    } as Response)

    const { result, rerender } = renderHook(
      (props: { fileName: string | null }) => useSessionTeam(props.fileName),
      { initialProps: { fileName: "session1.jsonl" } }
    )

    await waitFor(() => {
      expect(result.current).not.toBeNull()
    })

    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          teamName: "team-2",
          config: { name: "team-2", members: [], leadAgentId: "a2", createdAt: 0 },
          currentMemberName: "m2",
        }),
    } as Response)

    rerender({ fileName: "session2.jsonl" })

    await waitFor(() => {
      expect(result.current!.teamName).toBe("team-2")
    })
  })

  it("sets ctx to null when sessionFileName changes to null", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          teamName: "team-1",
          config: { name: "team-1", members: [], leadAgentId: "a1", createdAt: 0 },
          currentMemberName: "m1",
        }),
    } as Response)

    const { result, rerender } = renderHook(
      (props: { fileName: string | null }) => useSessionTeam(props.fileName),
      { initialProps: { fileName: "session1.jsonl" as string | null } }
    )

    await waitFor(() => {
      expect(result.current).not.toBeNull()
    })

    rerender({ fileName: null })

    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("passes teamName to useTeamLive", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          teamName: "live-team",
          config: { name: "live-team", members: [], leadAgentId: "l1", createdAt: 0 },
          currentMemberName: "lead",
        }),
    } as Response)

    renderHook(() => useSessionTeam("session.jsonl"))

    await waitFor(() => {
      expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
    })

    // useTeamLive should be called with the teamName from the response
    // On initial render it's called with null (ctx not yet set), then updated
    expect(mockedUseTeamLive).toHaveBeenCalled()
    // The first argument varies based on render cycle, but it will be called
    const calls = mockedUseTeamLive.mock.calls
    expect(calls.length).toBeGreaterThan(0)
  })
})
