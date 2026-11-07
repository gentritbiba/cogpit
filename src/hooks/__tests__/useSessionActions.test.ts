import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// Mock auth module
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  isRemoteClient: vi.fn(() => false),
}))

// Mock sessionCache module
vi.mock("@/lib/sessionCache", async () => {
  const device = await import("@/lib/device")
  return {
    sessionCache: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      update: vi.fn(),
      evict: vi.fn(),
      clear: vi.fn(),
    },
    sessionCacheKey: (dirName: string, fileName: string) => `${device.getActiveDeviceScope()}:${dirName}/${fileName}`,
  }
})

// Mock device scope so we can drive device/revision changes mid-flight.
vi.mock("@/lib/device", () => ({
  getActiveDeviceScope: vi.fn(() => "local"),
  getActiveIdentity: vi.fn(() => null),
  deviceScopedKey: (key: string) => key,
}))

import { useSessionActions } from "@/hooks/useSessionActions"
import { createSessionController } from "@/lib/sessionLoader"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import { getActiveDeviceScope } from "@/lib/device"
import type { Turn } from "../../../shared/session/types"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../../shared/session/sessionDigest"
import type { SessionTeamContext } from "@/hooks/useSessionTeam"
import type { TeamMember } from "@/lib/team-types"
import type { SessionAction } from "@/hooks/useSessionState"

const mockAuthFetch = vi.mocked(authFetch)
const mockSessionCache = vi.mocked(sessionCache)
const mockGetActiveDeviceScope = vi.mocked(getActiveDeviceScope)

function makeSession(overrides?: Partial<SessionView>): SessionView {
  return {
    sessionId: "test-session",
    version: "1",
    gitBranch: "main",
    cwd: "/test",
    slug: "test",
    name: "",
    model: "claude-3",
    turns: [],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 0,
    },
    digest: EMPTY_SESSION_DIGEST,
    ...overrides,
  }
}

function makeDefaultOpts(session?: SessionView) {
  const parsedSession = session ?? makeSession()
  const workerParse = vi.fn(() => Promise.resolve(parsedSession))
  const dispatch = vi.fn<(action: SessionAction) => void>()
  const opts: Parameters<typeof useSessionActions>[0] & { dispatch: typeof dispatch; workerParse: typeof workerParse } = {
    dispatch,
    isMobile: false,
    teamContext: null,
    scrollToBottomInstant: vi.fn(),
    resetTurnCount: vi.fn(),
    sessions: createSessionController({ parse: workerParse, dispatch }),
    workerParse,
  }
  return opts
}

function makeTeamContext(teamName: string): SessionTeamContext {
  return {
    teamName,
    config: {
      name: teamName,
      createdAt: 0,
      leadAgentId: "lead",
      members: [],
    },
    currentMemberName: null,
  }
}

function makeTeamMember(name: string, cwd = "/dir"): TeamMember {
  return {
    agentId: name.toLowerCase(),
    name,
    agentType: "general-purpose",
    joinedAt: 0,
    cwd,
  }
}

/** Build a mock tail response */
function makeTailResponse(overrides?: object) {
  return JSON.stringify({
    headerLines: ["{}"],
    tailLines: ["{}"],
    byteOffset: 100,
    totalSize: 200,
    hasMore: false,
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: cache miss
  vi.mocked(sessionCache.get).mockReturnValue(undefined)
  // Default: stay on the local device across a fetch
  mockGetActiveDeviceScope.mockReturnValue("local")
})

describe("useSessionActions", () => {
  describe("showing a loaded session", () => {
    it("dispatches LOAD_SESSION and resets turn count", async () => {
      const session = makeSession({ turns: [{ id: "t1" } as unknown as Turn, { id: "t2" } as unknown as Turn] })
      const opts = makeDefaultOpts(session)
      mockAuthFetch.mockResolvedValue(new Response(makeTailResponse({ end: 190 }), { status: 200 }))
      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("dir", "file.jsonl")
      })

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "LOAD_SESSION",
        session,
        source: expect.objectContaining({ dirName: "dir", fileName: "file.jsonl", watchOffset: 190 }),
        isMobile: false,
      })
      expect(opts.resetTurnCount).toHaveBeenCalledWith(2)
      expect(opts.scrollToBottomInstant).toHaveBeenCalled()
    })

    it("clears load error on success", () => {
      const opts = makeDefaultOpts()
      const { result } = renderHook(() => useSessionActions(opts))

      // No error initially
      expect(result.current.loadError).toBeNull()
    })
  })

  describe("handleDashboardSelect", () => {
    it("fetches session via tail endpoint, parses it, and shows it", async () => {
      const session = makeSession()
      const opts = makeDefaultOpts(session)
      mockAuthFetch.mockResolvedValue(
        new Response(makeTailResponse(), { status: 200 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("my-dir", "session.jsonl")
      })

      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/sessions/my-dir/session.jsonl?tail=10&unit=turns&projection=results-v1",
        { background: false, signal: expect.any(AbortSignal) },
      )
      expect(opts.workerParse).toHaveBeenCalled()
      expect(opts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_SESSION" })
      )
    })

    it("uses cache hit for instant switch without fetching", async () => {
      const session = makeSession()
      const opts = makeDefaultOpts(session)
      const cachedSource = { dirName: "my-dir", fileName: "session.jsonl", watchOffset: 6, loadId: 1 }
      vi.mocked(sessionCache.get).mockReturnValue({
        parsed: session,
        source: cachedSource,
        olderTurns: [],
        nextByteOffset: 100,
        hasMore: false,
        lastAccessed: Date.now(),
      })

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("my-dir", "session.jsonl")
      })

      // Should not fetch when cache hit
      expect(mockAuthFetch).not.toHaveBeenCalled()
      expect(opts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_SESSION" })
      )
    })

    it("encodes dirName and fileName in the URL", async () => {
      const opts = makeDefaultOpts()
      mockAuthFetch.mockResolvedValue(
        new Response(makeTailResponse(), { status: 200 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("dir with spaces", "file&name.jsonl")
      })

      expect(mockAuthFetch).toHaveBeenCalledWith(
        `/api/sessions/${encodeURIComponent("dir with spaces")}/${encodeURIComponent("file&name.jsonl")}?tail=10&unit=turns&projection=results-v1`,
        { background: false, signal: expect.any(AbortSignal) },
      )
    })

    it("sets loadError on non-ok response", async () => {
      const opts = makeDefaultOpts()
      mockAuthFetch.mockResolvedValue(
        new Response("not found", { status: 404 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("dir", "file.jsonl")
      })

      expect(result.current.loadError).toBe("Failed to load session (404)")
      expect(opts.dispatch).not.toHaveBeenCalled()
    })

    it("sets loadError on fetch exception", async () => {
      const opts = makeDefaultOpts()
      mockAuthFetch.mockRejectedValue(new Error("Network down"))

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("dir", "file.jsonl")
      })

      expect(result.current.loadError).toBe("Network down")
    })

    it("sets generic error for non-Error exceptions", async () => {
      const opts = makeDefaultOpts()
      mockAuthFetch.mockRejectedValue("some string error")

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("dir", "file.jsonl")
      })

      expect(result.current.loadError).toBe("Failed to load session")
    })

    it("stores parsed session in cache after successful fetch", async () => {
      const session = makeSession()
      const opts = makeDefaultOpts(session)
      mockAuthFetch.mockResolvedValue(
        new Response(makeTailResponse({ byteOffset: 150, hasMore: false }), { status: 200 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("my-dir", "session.jsonl")
      })

      expect(mockSessionCache.set).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ dirName: "my-dir", fileName: "session.jsonl", watchOffset: 200 }),
        150,
        false,
      )
    })

    it("neither caches nor shows a session whose device changed mid-flight", async () => {
      const session = makeSession()
      const opts = makeDefaultOpts(session)
      mockAuthFetch.mockResolvedValue(
        new Response(makeTailResponse(), { status: 200 })
      )

      // The load keys itself to the device before the fetch, then re-reads
      // the key before the cache set. Simulate a switch between the two.
      mockGetActiveDeviceScope
        .mockReturnValueOnce("device-a") // key before authFetch
        .mockReturnValueOnce("device-b") // guard before sessionCache.set

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("my-dir", "session.jsonl")
      })

      // No cross-device cache poisoning, and the remounted app is not handed the old device's session.
      expect(mockSessionCache.set).not.toHaveBeenCalled()
      expect(opts.dispatch).not.toHaveBeenCalled()
    })
  })

  describe("handleTeamMemberSwitch", () => {
    it("does nothing when teamContext is null", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = null

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Bob", "/some/dir"))
      })

      expect(mockAuthFetch).not.toHaveBeenCalled()
      expect(opts.dispatch).not.toHaveBeenCalled()
    })

    it("fetches team member session via tail endpoint and dispatches SWITCH_TEAM_MEMBER", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = makeTeamContext("my-team")

      mockAuthFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ dirName: "member-dir", fileName: "session.jsonl" }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(makeTailResponse(), { status: 200 })
        )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Bob", "/some/dir"))
      })

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_LOADING_MEMBER",
        name: "Bob",
      })
      expect(mockAuthFetch).toHaveBeenCalledWith(
        `/api/team-member-session/${encodeURIComponent("my-team")}/${encodeURIComponent("Bob")}`,
        { signal: expect.any(AbortSignal) },
      )
      // Second call goes to the tail endpoint — not the full-file endpoint.
      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/sessions/member-dir/session.jsonl?tail=10&unit=turns&projection=results-v1",
        { background: false, signal: expect.any(AbortSignal) },
      )
      expect(opts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SWITCH_TEAM_MEMBER",
          memberName: "Bob",
        })
      )
      // Finally clears loading member
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_LOADING_MEMBER",
        name: null,
      })
    })

    it("sets loadError when first fetch fails", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = makeTeamContext("team")

      mockAuthFetch.mockResolvedValueOnce(
        new Response("error", { status: 404 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Bob"))
      })

      expect(result.current.loadError).toBe("Failed to find session for Bob")
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_LOADING_MEMBER",
        name: null,
      })
    })

    it("sets loadError when content fetch fails", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = makeTeamContext("team")

      mockAuthFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ dirName: "d", fileName: "f.jsonl" }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response("error", { status: 500 })
        )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Alice"))
      })

      expect(result.current.loadError).toBe("Failed to load session (500)")
    })

    it("second team-member switch to same session is a cache hit (no network)", async () => {
      const session = makeSession()
      const opts = makeDefaultOpts(session)
      opts.teamContext = makeTeamContext("team")

      // First switch: lookup + tail fetch.
      mockAuthFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ dirName: "d", fileName: "f.jsonl" }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(makeTailResponse(), { status: 200 })
        )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Alice"))
      })

      // After the first switch, simulate a cache hit on the same session.
      vi.mocked(sessionCache.get).mockReturnValue({
        parsed: session,
        source: { dirName: "d", fileName: "f.jsonl", watchOffset: 6, loadId: 1 },
        olderTurns: [],
        nextByteOffset: 100,
        hasMore: false,
        lastAccessed: Date.now(),
      })
      // Only the member lookup should happen on the second switch.
      mockAuthFetch.mockClear()
      mockAuthFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ dirName: "d", fileName: "f.jsonl" }), { status: 200 })
      )

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Alice"))
      })

      // Exactly one fetch (the member lookup) — no tail fetch for the cached session.
      expect(mockAuthFetch).toHaveBeenCalledTimes(1)
      expect(mockAuthFetch).toHaveBeenCalledWith(
        `/api/team-member-session/${encodeURIComponent("team")}/${encodeURIComponent("Alice")}`,
        { signal: expect.any(AbortSignal) },
      )
    })

    it("sets loadError on network exception and still clears loading", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = makeTeamContext("team")

      mockAuthFetch.mockRejectedValue(new Error("Timeout"))

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Alice"))
      })

      expect(result.current.loadError).toBe("Timeout")
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_LOADING_MEMBER",
        name: null,
      })
    })
  })

  describe("clearLoadError", () => {
    it("clears the load error", async () => {
      const opts = makeDefaultOpts()
      mockAuthFetch.mockResolvedValue(
        new Response("error", { status: 500 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("dir", "file.jsonl")
      })

      expect(result.current.loadError).not.toBeNull()

      act(() => result.current.clearLoadError())
      expect(result.current.loadError).toBeNull()
    })
  })

  describe("handleGoHome", () => {
    it("dispatches GO_HOME with isMobile", () => {
      const opts = makeDefaultOpts()
      opts.isMobile = true

      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleGoHome())

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "GO_HOME",
        isMobile: true,
      })
    })
  })

  describe("handleCloseSession", () => {
    it("dispatches CLOSE_SESSION with isMobile", () => {
      const opts = makeDefaultOpts()
      opts.isMobile = true

      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleCloseSession())

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "CLOSE_SESSION",
        isMobile: true,
      })
    })
  })

  describe("handleJumpToTurn", () => {
    it("dispatches JUMP_TO_TURN with index", () => {
      const opts = makeDefaultOpts()
      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleJumpToTurn(5))

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "JUMP_TO_TURN",
        index: 5,
        toolCallId: undefined,
      })
    })

    it("dispatches JUMP_TO_TURN with index and toolCallId", () => {
      const opts = makeDefaultOpts()
      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleJumpToTurn(3, "tc-123"))

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "JUMP_TO_TURN",
        index: 3,
        toolCallId: "tc-123",
      })
    })
  })

  describe("handleMobileTabChange", () => {
    it("dispatches SET_MOBILE_TAB", () => {
      const opts = makeDefaultOpts()
      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleMobileTabChange("workspace"))

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_MOBILE_TAB",
        tab: "workspace",
      })
    })

    it("does not restart navigation when the selected tab is already active", () => {
      const opts = makeDefaultOpts()
      opts.mobileTab = "workspace"
      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleMobileTabChange("workspace"))

      expect(opts.dispatch).not.toHaveBeenCalled()
    })
  })

  describe("handleTeamMemberSwitch error recovery", () => {
    it("clears loadError on next successful handleTeamMemberSwitch", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = makeTeamContext("team")

      // First call fails
      mockAuthFetch.mockResolvedValueOnce(
        new Response("error", { status: 404 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Bob"))
      })
      expect(result.current.loadError).not.toBeNull()

      // Second call succeeds — team switches go through the tail endpoint now,
      // so the second response must be a valid TailResponse JSON payload.
      mockAuthFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ dirName: "d", fileName: "f.jsonl" }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(makeTailResponse(), { status: 200 })
        )

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Alice"))
      })

      expect(result.current.loadError).toBeNull()
    })

    it("handles non-Error exceptions in handleTeamMemberSwitch", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = makeTeamContext("team")

      mockAuthFetch.mockRejectedValue("some string error")

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch(makeTeamMember("Bob"))
      })

      expect(result.current.loadError).toBe("Failed to switch team member")
      // Loading member should still be cleared
      expect(opts.dispatch).toHaveBeenCalledWith({ type: "SET_LOADING_MEMBER", name: null })
    })
  })

  describe("showing a loaded session on mobile", () => {
    it("passes isMobile from opts", async () => {
      const opts = makeDefaultOpts()
      opts.isMobile = true
      mockAuthFetch.mockResolvedValue(new Response(makeTailResponse(), { status: 200 }))
      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("d", "f.jsonl")
      })

      expect(opts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_SESSION", isMobile: true })
      )
    })
  })

  describe("handleDashboardSelect clears previous error", () => {
    it("clears loadError before starting new fetch", async () => {
      const opts = makeDefaultOpts()

      // First call fails
      mockAuthFetch.mockResolvedValueOnce(
        new Response("error", { status: 500 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("dir", "file.jsonl")
      })
      expect(result.current.loadError).not.toBeNull()

      // Second call succeeds
      mockAuthFetch.mockResolvedValueOnce(
        new Response(makeTailResponse(), { status: 200 })
      )

      await act(async () => {
        await result.current.handleDashboardSelect("dir2", "file2.jsonl")
      })

      expect(result.current.loadError).toBeNull()
    })
  })

  describe("stale opens (R1)", () => {
    function deferred() {
      let resolve!: (res: Response) => void
      const promise = new Promise<Response>((r) => { resolve = r })
      return { promise, resolve }
    }

    it("never shows a slow session over one the user clicked after it", async () => {
      const opts = makeDefaultOpts()
      const slow = deferred()
      const fast = deferred()
      mockAuthFetch.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
      const { result } = renderHook(() => useSessionActions(opts))

      let first!: Promise<void>
      let second!: Promise<void>
      act(() => {
        first = result.current.handleDashboardSelect("d", "slow.jsonl")
        second = result.current.handleDashboardSelect("d", "fast.jsonl")
      })
      await act(async () => {
        fast.resolve(new Response(makeTailResponse(), { status: 200 }))
        await second
        slow.resolve(new Response("gone", { status: 500 }))
        await first
      })

      const loads = opts.dispatch.mock.calls.map(([a]) => a).filter((a) => a.type === "LOAD_SESSION")
      expect(loads.map((a) => a.source.fileName)).toEqual(["fast.jsonl"])
      // The slow open lost, so its failure is nobody's error.
      expect(result.current.loadError).toBeNull()
    })

    it("keeps the loading indicator of the team switch that superseded another", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = makeTeamContext("team")
      const bobLookup = deferred()
      const aliceLookup = deferred()
      mockAuthFetch.mockReturnValueOnce(bobLookup.promise).mockReturnValueOnce(aliceLookup.promise)
      const { result } = renderHook(() => useSessionActions(opts))

      let bob!: Promise<void>
      act(() => {
        bob = result.current.handleTeamMemberSwitch(makeTeamMember("Bob"))
        void result.current.handleTeamMemberSwitch(makeTeamMember("Alice"))
      })
      await act(async () => {
        bobLookup.resolve(new Response(JSON.stringify({ dirName: "d", fileName: "bob.jsonl" }), { status: 200 }))
        await bob
      })

      const loading = opts.dispatch.mock.calls.map(([a]) => a).filter((a) => a.type === "SET_LOADING_MEMBER")
      expect(loading).toEqual([
        { type: "SET_LOADING_MEMBER", name: "Bob" },
        { type: "SET_LOADING_MEMBER", name: "Alice" },
      ])
      expect(opts.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "SWITCH_TEAM_MEMBER" }))
    })
  })
})
