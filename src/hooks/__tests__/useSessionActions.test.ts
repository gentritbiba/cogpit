import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// Mock auth module
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  isRemoteClient: vi.fn(() => false),
  getToken: vi.fn(() => null),
}))

// Mock parser module
vi.mock("@/lib/parser", () => ({
  parseSession: vi.fn(),
}))

import { useSessionActions } from "@/hooks/useSessionActions"
import { authFetch } from "@/lib/auth"
import { parseSession } from "@/lib/parser"
import type { ParsedSession, Turn } from "@/lib/types"
import type { SessionTeamContext } from "@/hooks/useSessionTeam"

const mockAuthFetch = vi.mocked(authFetch)
const mockParseSession = vi.mocked(parseSession)

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

function makeDefaultOpts() {
  return {
    dispatch: vi.fn(),
    isMobile: false,
    teamContext: null,
    scrollToBottomInstant: vi.fn(),
    resetTurnCount: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
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
    it("fetches session, parses it, and calls handleLoadSession", async () => {
      const opts = makeDefaultOpts()
      const session = makeParsedSession()
      mockAuthFetch.mockResolvedValue(
        new Response("jsonl-content", { status: 200 })
      )
      mockParseSession.mockReturnValue(session)

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("my-dir", "session.jsonl")
      })

      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/sessions/my-dir/session.jsonl"
      )
      expect(mockParseSession).toHaveBeenCalledWith("jsonl-content")
      expect(opts.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_SESSION" })
      )
    })

    it("encodes dirName and fileName in the URL", async () => {
      const opts = makeDefaultOpts()
      mockAuthFetch.mockResolvedValue(
        new Response("data", { status: 200 })
      )
      mockParseSession.mockReturnValue(makeParsedSession())

      const { result } = renderHook(() => useSessionActions(opts))

      await act(async () => {
        await result.current.handleDashboardSelect("dir with spaces", "file&name.jsonl")
      })

      expect(mockAuthFetch).toHaveBeenCalledWith(
        `/api/sessions/${encodeURIComponent("dir with spaces")}/${encodeURIComponent("file&name.jsonl")}`
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
  })

  describe("handleOpenSessionFromTeam", () => {
    it("dispatches LOAD_SESSION_FROM_TEAM with memberName", async () => {
      const opts = makeDefaultOpts()
      const session = makeParsedSession()
      mockAuthFetch.mockResolvedValue(
        new Response("jsonl-text", { status: 200 })
      )
      mockParseSession.mockReturnValue(session)

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

      const session = makeParsedSession()
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
      mockParseSession.mockReturnValue(session)

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

      expect(result.current.loadError).toBe("Failed to load session for Alice")
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
      const session = makeParsedSession()
      mockAuthFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ dirName: "d", fileName: "f.jsonl" }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response("raw-text", { status: 200 })
        )
      mockParseSession.mockReturnValue(session)

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
      const session = makeParsedSession()
      mockAuthFetch.mockResolvedValueOnce(
        new Response("data", { status: 200 })
      )
      mockParseSession.mockReturnValue(session)

      await act(async () => {
        await result.current.handleDashboardSelect("dir2", "file2.jsonl")
      })

      expect(result.current.loadError).toBeNull()
    })
  })
})
