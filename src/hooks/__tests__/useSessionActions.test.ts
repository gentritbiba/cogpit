import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// Mock auth module
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  isRemoteClient: vi.fn(() => false),
  getToken: vi.fn(() => null),
}))

// Mock sessionCache module
vi.mock("@/lib/sessionCache", () => ({
  sessionCache: {
    get: vi.fn(() => undefined),
    set: vi.fn(),
    update: vi.fn(),
    updateRawText: vi.fn(),
    evict: vi.fn(),
    clear: vi.fn(),
  },
}))

import { useSessionActions } from "@/hooks/useSessionActions"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import type { ParsedSession, Turn } from "@/lib/types"
import type { SessionTeamContext } from "@/hooks/useSessionTeam"

const mockAuthFetch = vi.mocked(authFetch)
const mockSessionCache = vi.mocked(sessionCache)

function makeParsedSession(overrides?: Partial<ParsedSession>): ParsedSession {
  return {
    sessionId: "test-session",
    version: "1",
    gitBranch: "main",
    cwd: "/test",
    slug: "test",
    model: "claude-3",
    turns: [],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUSD: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 0,
    },
    rawMessages: [],
    ...overrides,
  }
}

function makeDefaultOpts(session?: ParsedSession) {
  const parsedSession = session ?? makeParsedSession()
  const workerParse = vi.fn(() => Promise.resolve(parsedSession))
  return {
    dispatch: vi.fn(),
    isMobile: false,
    teamContext: null,
    scrollToBottomInstant: vi.fn(),
    resetTurnCount: vi.fn(),
    workerParse,
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
})

describe("useSessionActions", () => {
  describe("handleLoadSession", () => {
    it("dispatches LOAD_SESSION and resets turn count", () => {
      const opts = makeDefaultOpts()
      const { result } = renderHook(() => useSessionActions(opts))

      const session = makeParsedSession({ turns: [{ id: "t1" } as unknown as Turn, { id: "t2" } as unknown as Turn] })

      act(() => {
        result.current.handleLoadSession(session, {
          dirName: "dir",
          fileName: "file.jsonl",
          rawText: "raw",
        })
      })

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "LOAD_SESSION",
        session,
        source: { dirName: "dir", fileName: "file.jsonl", rawText: "raw" },
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
    it("fetches session via tail endpoint, parses it, and calls handleLoadSession", async () => {
      const session = makeParsedSession()
      const opts = makeDefaultOpts(session)
      mockAuthFetch.mockResolvedValue(
        new Response(makeTailResponse(), { status: 200 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("my-dir", "session.jsonl")
      })

      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/sessions/my-dir/session.jsonl?tail=30"
      )
      expect(opts.workerParse).toHaveBeenCalled()
      expect(opts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_SESSION" })
      )
    })

    it("uses cache hit for instant switch without fetching", async () => {
      const session = makeParsedSession()
      const opts = makeDefaultOpts(session)
      const cachedSource = { dirName: "my-dir", fileName: "session.jsonl", rawText: "cached" }
      vi.mocked(sessionCache.get).mockReturnValue({
        parsed: session,
        source: cachedSource,
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
        `/api/sessions/${encodeURIComponent("dir with spaces")}/${encodeURIComponent("file&name.jsonl")}?tail=30`
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
      const session = makeParsedSession()
      const opts = makeDefaultOpts(session)
      mockAuthFetch.mockResolvedValue(
        new Response(makeTailResponse({ byteOffset: 150, hasMore: false }), { status: 200 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("my-dir", "session.jsonl")
      })

      expect(mockSessionCache.set).toHaveBeenCalledWith(
        "my-dir",
        "session.jsonl",
        session,
        expect.any(String),
        150,
        false,
        expect.anything(),
      )
    })
  })

  describe("handleOpenSessionFromTeam", () => {
    it("dispatches LOAD_SESSION_FROM_TEAM with memberName", async () => {
      const session = makeParsedSession()
      const opts = makeDefaultOpts(session)
      mockAuthFetch.mockResolvedValue(
        new Response("jsonl-text", { status: 200 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleOpenSessionFromTeam("dir", "file.jsonl", "Alice")
      })

      expect(opts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "LOAD_SESSION_FROM_TEAM",
          memberName: "Alice",
        })
      )
      expect(opts.resetTurnCount).toHaveBeenCalled()
      expect(opts.scrollToBottomInstant).toHaveBeenCalled()
    })

    it("sets loadError on non-ok response", async () => {
      const opts = makeDefaultOpts()
      mockAuthFetch.mockResolvedValue(
        new Response("error", { status: 500 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleOpenSessionFromTeam("dir", "file.jsonl")
      })

      expect(result.current.loadError).toBe("Failed to load team session (500)")
    })

    it("sets loadError on fetch error", async () => {
      const opts = makeDefaultOpts()
      mockAuthFetch.mockRejectedValue(new Error("Connection refused"))

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleOpenSessionFromTeam("dir", "file.jsonl")
      })

      expect(result.current.loadError).toBe("Connection refused")
    })
  })

  describe("handleTeamMemberSwitch", () => {
    it("does nothing when teamContext is null", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = null

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch({
          name: "Bob",
          dir: "/some/dir",
          active: true,
        })
      })

      expect(mockAuthFetch).not.toHaveBeenCalled()
      expect(opts.dispatch).not.toHaveBeenCalled()
    })

    it("fetches team member session and dispatches SWITCH_TEAM_MEMBER", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = {
        teamName: "my-team",
        members: [],
        activeMember: null,
      } as unknown as SessionTeamContext

      mockAuthFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ dirName: "member-dir", fileName: "session.jsonl" }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response("raw-session-text", { status: 200 })
        )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch({
          name: "Bob",
          dir: "/some/dir",
          active: true,
        })
      })

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_LOADING_MEMBER",
        name: "Bob",
      })
      expect(mockAuthFetch).toHaveBeenCalledWith(
        `/api/team-member-session/${encodeURIComponent("my-team")}/${encodeURIComponent("Bob")}`
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
      opts.teamContext = { teamName: "team", members: [], activeMember: null } as unknown as SessionTeamContext

      mockAuthFetch.mockResolvedValueOnce(
        new Response("error", { status: 404 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch({
          name: "Bob",
          dir: "/dir",
          active: true,
        })
      })

      expect(result.current.loadError).toBe("Failed to find session for Bob")
      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_LOADING_MEMBER",
        name: null,
      })
    })

    it("sets loadError when content fetch fails", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = { teamName: "team", members: [], activeMember: null } as unknown as SessionTeamContext

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
        await result.current.handleTeamMemberSwitch({
          name: "Alice",
          dir: "/dir",
          active: true,
        })
      })

      expect(result.current.loadError).toBe("Failed to load session for Alice (500)")
    })

    it("sets loadError on network exception and still clears loading", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = { teamName: "team", members: [], activeMember: null } as unknown as SessionTeamContext

      mockAuthFetch.mockRejectedValue(new Error("Timeout"))

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch({
          name: "Alice",
          dir: "/dir",
          active: true,
        })
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

  describe("handleSelectTeam", () => {
    it("dispatches SELECT_TEAM with teamName and isMobile", () => {
      const opts = makeDefaultOpts()
      opts.isMobile = true

      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleSelectTeam("my-team"))

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SELECT_TEAM",
        teamName: "my-team",
        isMobile: true,
      })
    })
  })

  describe("handleBackFromTeam", () => {
    it("dispatches BACK_FROM_TEAM", () => {
      const opts = makeDefaultOpts()
      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleBackFromTeam())

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "BACK_FROM_TEAM",
        isMobile: false,
      })
    })
  })

  describe("handleOpenTeamFromBar", () => {
    it("does nothing when teamContext is null", () => {
      const opts = makeDefaultOpts()
      opts.teamContext = null

      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleOpenTeamFromBar())

      expect(opts.dispatch).not.toHaveBeenCalled()
    })

    it("dispatches SELECT_TEAM using teamContext.teamName", () => {
      const opts = makeDefaultOpts()
      opts.teamContext = { teamName: "dev-team", members: [], activeMember: null } as unknown as SessionTeamContext

      const { result } = renderHook(() => useSessionActions(opts))

      act(() => result.current.handleOpenTeamFromBar())

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SELECT_TEAM",
        teamName: "dev-team",
        isMobile: false,
      })
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

      act(() => result.current.handleMobileTabChange("stats"))

      expect(opts.dispatch).toHaveBeenCalledWith({
        type: "SET_MOBILE_TAB",
        tab: "stats",
      })
    })
  })

  describe("handleTeamMemberSwitch error recovery", () => {
    it("clears loadError on next successful handleTeamMemberSwitch", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = { teamName: "team", members: [], activeMember: null } as unknown as SessionTeamContext

      // First call fails
      mockAuthFetch.mockResolvedValueOnce(
        new Response("error", { status: 404 })
      )

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch({ name: "Bob", dir: "/dir", active: true })
      })
      expect(result.current.loadError).not.toBeNull()

      // Second call succeeds
      mockAuthFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ dirName: "d", fileName: "f.jsonl" }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response("raw-text", { status: 200 })
        )

      await act(async () => {
        await result.current.handleTeamMemberSwitch({ name: "Alice", dir: "/dir", active: true })
      })

      expect(result.current.loadError).toBeNull()
    })

    it("handles non-Error exceptions in handleTeamMemberSwitch", async () => {
      const opts = makeDefaultOpts()
      opts.teamContext = { teamName: "team", members: [], activeMember: null } as unknown as SessionTeamContext

      mockAuthFetch.mockRejectedValue("some string error")

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleTeamMemberSwitch({ name: "Bob", dir: "/dir", active: true })
      })

      expect(result.current.loadError).toBe("Failed to switch team member")
      // Loading member should still be cleared
      expect(opts.dispatch).toHaveBeenCalledWith({ type: "SET_LOADING_MEMBER", name: null })
    })
  })

  describe("handleLoadSession edge cases", () => {
    it("passes isMobile from opts", () => {
      const opts = makeDefaultOpts()
      opts.isMobile = true
      const { result } = renderHook(() => useSessionActions(opts))
      const session = makeParsedSession()

      act(() => {
        result.current.handleLoadSession(session, { dirName: "d", fileName: "f.jsonl", rawText: "" })
      })

      expect(opts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ isMobile: true })
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
})
