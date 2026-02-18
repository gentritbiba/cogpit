import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useSessionState } from "@/hooks/useSessionState"
import type { SessionState } from "@/hooks/useSessionState"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session",
    version: "1.0",
    gitBranch: "main",
    cwd: "/project",
    slug: "test",
    model: "claude-opus-4-6-20250115",
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

function makeSource(overrides: Partial<SessionSource> = {}): SessionSource {
  return {
    dirName: "test-dir",
    fileName: "test.jsonl",
    rawText: "",
    ...overrides,
  }
}

function renderState() {
  return renderHook(() => useSessionState())
}

function getState(hook: ReturnType<typeof renderState>): SessionState {
  return hook.result.current[0]
}

function dispatch(hook: ReturnType<typeof renderState>, ...actions: Parameters<typeof hook.result.current[1]>) {
  return act(() => hook.result.current[1](...actions))
}

// ── Initial State ───────────────────────────────────────────────────────

describe("useSessionState", () => {
  describe("initial state", () => {
    it("starts with null session", () => {
      const hook = renderState()
      expect(getState(hook).session).toBeNull()
    })

    it("starts with null sessionSource", () => {
      const hook = renderState()
      expect(getState(hook).sessionSource).toBeNull()
    })

    it("starts with null pendingDirName", () => {
      const hook = renderState()
      expect(getState(hook).pendingDirName).toBeNull()
    })

    it("starts with null activeTurnIndex", () => {
      const hook = renderState()
      expect(getState(hook).activeTurnIndex).toBeNull()
    })

    it("starts with empty searchQuery", () => {
      const hook = renderState()
      expect(getState(hook).searchQuery).toBe("")
    })

    it("starts with expandAll false", () => {
      const hook = renderState()
      expect(getState(hook).expandAll).toBe(false)
    })

    it("starts with sessionChangeKey 0", () => {
      const hook = renderState()
      expect(getState(hook).sessionChangeKey).toBe(0)
    })

    it("starts with mainView as sessions", () => {
      const hook = renderState()
      expect(getState(hook).mainView).toBe("sessions")
    })

    it("starts with sidebarTab as browse", () => {
      const hook = renderState()
      expect(getState(hook).sidebarTab).toBe("browse")
    })

    it("starts with mobileTab as sessions", () => {
      const hook = renderState()
      expect(getState(hook).mobileTab).toBe("sessions")
    })

    it("starts with null dashboardProject", () => {
      const hook = renderState()
      expect(getState(hook).dashboardProject).toBeNull()
    })
  })

  // ── LOAD_SESSION ────────────────────────────────────────────────────

  describe("LOAD_SESSION", () => {
    it("sets session and source", () => {
      const hook = renderState()
      const session = makeSession()
      const source = makeSource()
      dispatch(hook, { type: "LOAD_SESSION", session, source, isMobile: false })

      const s = getState(hook)
      expect(s.session).toBe(session)
      expect(s.sessionSource).toBe(source)
    })

    it("clears pendingDirName", () => {
      const hook = renderState()
      dispatch(hook, { type: "INIT_PENDING_SESSION", dirName: "pending-1", isMobile: false })
      expect(getState(hook).pendingDirName).toBe("pending-1")

      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).pendingDirName).toBeNull()
    })

    it("resets activeTurnIndex and search", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      dispatch(hook, { type: "JUMP_TO_TURN", index: 5 })
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "test" })

      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).activeTurnIndex).toBeNull()
      expect(getState(hook).searchQuery).toBe("")
    })

    it("increments sessionChangeKey", () => {
      const hook = renderState()
      expect(getState(hook).sessionChangeKey).toBe(0)
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).sessionChangeKey).toBe(1)
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).sessionChangeKey).toBe(2)
    })

    it("sets mobileTab to chat when isMobile is true", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: true })
      expect(getState(hook).mobileTab).toBe("chat")
    })

    it("does not change mobileTab when isMobile is false", () => {
      const hook = renderState()
      expect(getState(hook).mobileTab).toBe("sessions")
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).mobileTab).toBe("sessions")
    })

    it("clears selectedTeam and currentMemberName", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "team1", isMobile: false })
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).selectedTeam).toBeNull()
      expect(getState(hook).currentMemberName).toBeNull()
    })

    it("resets mainView to sessions", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "team1", isMobile: false })
      expect(getState(hook).mainView).toBe("teams")
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).mainView).toBe("sessions")
    })

    it("clears dashboardProject", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_DASHBOARD_PROJECT", dirName: "proj-1" })
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).dashboardProject).toBeNull()
    })
  })

  // ── GO_HOME ─────────────────────────────────────────────────────────

  describe("GO_HOME", () => {
    it("clears session and source", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      dispatch(hook, { type: "GO_HOME", isMobile: false })
      expect(getState(hook).session).toBeNull()
      expect(getState(hook).sessionSource).toBeNull()
    })

    it("clears pendingDirName", () => {
      const hook = renderState()
      dispatch(hook, { type: "INIT_PENDING_SESSION", dirName: "pending", isMobile: false })
      dispatch(hook, { type: "GO_HOME", isMobile: false })
      expect(getState(hook).pendingDirName).toBeNull()
    })

    it("resets UI state", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      dispatch(hook, { type: "JUMP_TO_TURN", index: 3 })
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "search" })
      dispatch(hook, { type: "SET_EXPAND_ALL", value: true })

      dispatch(hook, { type: "GO_HOME", isMobile: false })
      expect(getState(hook).activeTurnIndex).toBeNull()
      expect(getState(hook).searchQuery).toBe("")
      expect(getState(hook).expandAll).toBe(false)
    })

    it("sets mobileTab to sessions on mobile", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: true })
      expect(getState(hook).mobileTab).toBe("chat")
      dispatch(hook, { type: "GO_HOME", isMobile: true })
      expect(getState(hook).mobileTab).toBe("sessions")
    })

    it("resets mainView, selectedTeam, and dashboardProject", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "t1", isMobile: false })
      dispatch(hook, { type: "SET_DASHBOARD_PROJECT", dirName: "p1" })
      dispatch(hook, { type: "GO_HOME", isMobile: false })
      expect(getState(hook).mainView).toBe("sessions")
      expect(getState(hook).selectedTeam).toBeNull()
      expect(getState(hook).dashboardProject).toBeNull()
    })
  })

  // ── LOAD_SESSION_FROM_TEAM ──────────────────────────────────────────

  describe("LOAD_SESSION_FROM_TEAM", () => {
    it("sets session and source from team context", () => {
      const hook = renderState()
      const session = makeSession()
      const source = makeSource()
      dispatch(hook, { type: "LOAD_SESSION_FROM_TEAM", session, source, memberName: "agent-1", isMobile: false })
      expect(getState(hook).session).toBe(session)
      expect(getState(hook).sessionSource).toBe(source)
      expect(getState(hook).currentMemberName).toBe("agent-1")
    })

    it("increments sessionChangeKey", () => {
      const hook = renderState()
      const before = getState(hook).sessionChangeKey
      dispatch(hook, { type: "LOAD_SESSION_FROM_TEAM", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).sessionChangeKey).toBe(before + 1)
    })

    it("sets mobileTab to chat on mobile", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION_FROM_TEAM", session: makeSession(), source: makeSource(), isMobile: true })
      expect(getState(hook).mobileTab).toBe("chat")
    })

    it("preserves current member name when not provided", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_CURRENT_MEMBER_NAME", name: "existing-member" })
      dispatch(hook, { type: "LOAD_SESSION_FROM_TEAM", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).currentMemberName).toBe("existing-member")
    })
  })

  // ── SWITCH_TEAM_MEMBER ──────────────────────────────────────────────

  describe("SWITCH_TEAM_MEMBER", () => {
    it("updates session and member name", () => {
      const hook = renderState()
      const session = makeSession()
      const source = makeSource()
      dispatch(hook, { type: "SWITCH_TEAM_MEMBER", session, source, memberName: "member-2" })
      expect(getState(hook).session).toBe(session)
      expect(getState(hook).currentMemberName).toBe("member-2")
    })

    it("resets activeTurnIndex and search", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      dispatch(hook, { type: "JUMP_TO_TURN", index: 5 })
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "hello" })

      dispatch(hook, { type: "SWITCH_TEAM_MEMBER", session: makeSession(), source: makeSource(), memberName: "m" })
      expect(getState(hook).activeTurnIndex).toBeNull()
      expect(getState(hook).searchQuery).toBe("")
    })

    it("increments sessionChangeKey", () => {
      const hook = renderState()
      const before = getState(hook).sessionChangeKey
      dispatch(hook, { type: "SWITCH_TEAM_MEMBER", session: makeSession(), source: makeSource(), memberName: "m" })
      expect(getState(hook).sessionChangeKey).toBe(before + 1)
    })
  })

  // ── SELECT_TEAM / BACK_FROM_TEAM ──────────────────────────────────

  describe("SELECT_TEAM", () => {
    it("sets selectedTeam and mainView to teams", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "alpha", isMobile: false })
      expect(getState(hook).selectedTeam).toBe("alpha")
      expect(getState(hook).mainView).toBe("teams")
    })

    it("sets mobileTab to teams on mobile", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "alpha", isMobile: true })
      expect(getState(hook).mobileTab).toBe("teams")
    })
  })

  describe("BACK_FROM_TEAM", () => {
    it("clears selectedTeam and sets mainView to sessions", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "alpha", isMobile: false })
      dispatch(hook, { type: "BACK_FROM_TEAM", isMobile: false })
      expect(getState(hook).selectedTeam).toBeNull()
      expect(getState(hook).mainView).toBe("sessions")
    })

    it("sets mobileTab to sessions on mobile", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "alpha", isMobile: true })
      dispatch(hook, { type: "BACK_FROM_TEAM", isMobile: true })
      expect(getState(hook).mobileTab).toBe("sessions")
    })
  })

  // ── JUMP_TO_TURN ──────────────────────────────────────────────────

  describe("JUMP_TO_TURN", () => {
    it("sets activeTurnIndex", () => {
      const hook = renderState()
      dispatch(hook, { type: "JUMP_TO_TURN", index: 7 })
      expect(getState(hook).activeTurnIndex).toBe(7)
    })

    it("sets activeToolCallId when provided", () => {
      const hook = renderState()
      dispatch(hook, { type: "JUMP_TO_TURN", index: 3, toolCallId: "tc-42" })
      expect(getState(hook).activeTurnIndex).toBe(3)
      expect(getState(hook).activeToolCallId).toBe("tc-42")
    })

    it("clears activeToolCallId when not provided", () => {
      const hook = renderState()
      dispatch(hook, { type: "JUMP_TO_TURN", index: 3, toolCallId: "tc-42" })
      dispatch(hook, { type: "JUMP_TO_TURN", index: 5 })
      expect(getState(hook).activeToolCallId).toBeNull()
    })
  })

  // ── SET_SEARCH_QUERY ──────────────────────────────────────────────

  describe("SET_SEARCH_QUERY", () => {
    it("updates search query", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "find me" })
      expect(getState(hook).searchQuery).toBe("find me")
    })

    it("returns same state when value is unchanged (no-op optimization)", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "test" })
      const stateAfterFirst = getState(hook)
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "test" })
      expect(getState(hook)).toBe(stateAfterFirst)
    })
  })

  // ── SET_EXPAND_ALL / TOGGLE_EXPAND_ALL ────────────────────────────

  describe("SET_EXPAND_ALL", () => {
    it("sets expandAll to true", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_EXPAND_ALL", value: true })
      expect(getState(hook).expandAll).toBe(true)
    })

    it("returns same state when value is unchanged", () => {
      const hook = renderState()
      const initialState = getState(hook)
      dispatch(hook, { type: "SET_EXPAND_ALL", value: false })
      expect(getState(hook)).toBe(initialState)
    })
  })

  describe("TOGGLE_EXPAND_ALL", () => {
    it("toggles expandAll from false to true", () => {
      const hook = renderState()
      dispatch(hook, { type: "TOGGLE_EXPAND_ALL" })
      expect(getState(hook).expandAll).toBe(true)
    })

    it("toggles expandAll from true to false", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_EXPAND_ALL", value: true })
      dispatch(hook, { type: "TOGGLE_EXPAND_ALL" })
      expect(getState(hook).expandAll).toBe(false)
    })
  })

  // ── SET_MOBILE_TAB ────────────────────────────────────────────────

  describe("SET_MOBILE_TAB", () => {
    it("sets mobile tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "chat" })
      expect(getState(hook).mobileTab).toBe("chat")
    })

    it("sets sidebarTab to teams when tab is teams and no selectedTeam", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "teams" })
      expect(getState(hook).sidebarTab).toBe("teams")
    })

    it("keeps sidebarTab when tab is teams but selectedTeam exists", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "t1", isMobile: false })
      dispatch(hook, { type: "SET_SIDEBAR_TAB", tab: "browse" })
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "teams" })
      // selectedTeam exists, so sidebarTab stays as "browse"
      expect(getState(hook).sidebarTab).toBe("browse")
    })

    it("returns same state when tab and sidebarTab are unchanged", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "stats" })
      const stateAfter = getState(hook)
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "stats" })
      expect(getState(hook)).toBe(stateAfter)
    })
  })

  // ── UPDATE_SESSION ────────────────────────────────────────────────

  describe("UPDATE_SESSION", () => {
    it("replaces session without changing other state", () => {
      const hook = renderState()
      const session1 = makeSession({ sessionId: "s1" })
      const source = makeSource()
      dispatch(hook, { type: "LOAD_SESSION", session: session1, source, isMobile: false })
      dispatch(hook, { type: "JUMP_TO_TURN", index: 3 })

      const session2 = makeSession({ sessionId: "s2" })
      dispatch(hook, { type: "UPDATE_SESSION", session: session2 })
      expect(getState(hook).session).toBe(session2)
      // activeTurnIndex should NOT be reset
      expect(getState(hook).activeTurnIndex).toBe(3)
    })
  })

  // ── RELOAD_SESSION_CONTENT ────────────────────────────────────────

  describe("RELOAD_SESSION_CONTENT", () => {
    it("sets session and source and increments changeKey", () => {
      const hook = renderState()
      const before = getState(hook).sessionChangeKey
      const session = makeSession()
      const source = makeSource()
      dispatch(hook, { type: "RELOAD_SESSION_CONTENT", session, source })
      expect(getState(hook).session).toBe(session)
      expect(getState(hook).sessionSource).toBe(source)
      expect(getState(hook).sessionChangeKey).toBe(before + 1)
    })
  })

  // ── SET_CURRENT_MEMBER_NAME ───────────────────────────────────────

  describe("SET_CURRENT_MEMBER_NAME", () => {
    it("sets current member name", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_CURRENT_MEMBER_NAME", name: "agent-x" })
      expect(getState(hook).currentMemberName).toBe("agent-x")
    })

    it("clears current member name with null", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_CURRENT_MEMBER_NAME", name: "agent-x" })
      dispatch(hook, { type: "SET_CURRENT_MEMBER_NAME", name: null })
      expect(getState(hook).currentMemberName).toBeNull()
    })

    it("returns same state when unchanged", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_CURRENT_MEMBER_NAME", name: "a" })
      const s = getState(hook)
      dispatch(hook, { type: "SET_CURRENT_MEMBER_NAME", name: "a" })
      expect(getState(hook)).toBe(s)
    })
  })

  // ── GUARD_MOBILE_TAB ──────────────────────────────────────────────

  describe("GUARD_MOBILE_TAB", () => {
    it("falls back from chat to sessions when no session", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "chat" })
      dispatch(hook, { type: "GUARD_MOBILE_TAB", hasSession: false, hasTeam: false })
      expect(getState(hook).mobileTab).toBe("sessions")
    })

    it("falls back from stats to sessions when no session", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "stats" })
      dispatch(hook, { type: "GUARD_MOBILE_TAB", hasSession: false, hasTeam: false })
      expect(getState(hook).mobileTab).toBe("sessions")
    })

    it("falls back from teams to sessions when no team", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "teams" })
      dispatch(hook, { type: "GUARD_MOBILE_TAB", hasSession: false, hasTeam: false })
      expect(getState(hook).mobileTab).toBe("sessions")
    })

    it("keeps chat tab when session exists", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "chat" })
      dispatch(hook, { type: "GUARD_MOBILE_TAB", hasSession: true, hasTeam: false })
      expect(getState(hook).mobileTab).toBe("chat")
    })

    it("keeps teams tab when team exists", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_MOBILE_TAB", tab: "teams" })
      dispatch(hook, { type: "GUARD_MOBILE_TAB", hasSession: false, hasTeam: true })
      expect(getState(hook).mobileTab).toBe("teams")
    })

    it("returns same state when no fallback needed", () => {
      const hook = renderState()
      const s = getState(hook)
      // mobileTab is "sessions", hasSession: false, hasTeam: false — no change needed
      dispatch(hook, { type: "GUARD_MOBILE_TAB", hasSession: false, hasTeam: false })
      expect(getState(hook)).toBe(s)
    })
  })

  // ── SET_LOADING_MEMBER ────────────────────────────────────────────

  describe("SET_LOADING_MEMBER", () => {
    it("sets loading member", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_LOADING_MEMBER", name: "agent-z" })
      expect(getState(hook).loadingMember).toBe("agent-z")
    })

    it("clears loading member with null", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_LOADING_MEMBER", name: "x" })
      dispatch(hook, { type: "SET_LOADING_MEMBER", name: null })
      expect(getState(hook).loadingMember).toBeNull()
    })

    it("returns same state when unchanged", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_LOADING_MEMBER", name: "x" })
      const s = getState(hook)
      dispatch(hook, { type: "SET_LOADING_MEMBER", name: "x" })
      expect(getState(hook)).toBe(s)
    })
  })

  // ── SET_SIDEBAR_TAB ───────────────────────────────────────────────

  describe("SET_SIDEBAR_TAB", () => {
    it("sets sidebar tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_SIDEBAR_TAB", tab: "teams" })
      expect(getState(hook).sidebarTab).toBe("teams")
    })

    it("returns same state when unchanged", () => {
      const hook = renderState()
      const s = getState(hook)
      dispatch(hook, { type: "SET_SIDEBAR_TAB", tab: "browse" })
      expect(getState(hook)).toBe(s)
    })
  })

  // ── SET_DASHBOARD_PROJECT ─────────────────────────────────────────

  describe("SET_DASHBOARD_PROJECT", () => {
    it("sets dashboard project", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_DASHBOARD_PROJECT", dirName: "my-project" })
      expect(getState(hook).dashboardProject).toBe("my-project")
    })

    it("clears with null", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_DASHBOARD_PROJECT", dirName: "p1" })
      dispatch(hook, { type: "SET_DASHBOARD_PROJECT", dirName: null })
      expect(getState(hook).dashboardProject).toBeNull()
    })

    it("returns same state when unchanged", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_DASHBOARD_PROJECT", dirName: null })
      const s = getState(hook)
      dispatch(hook, { type: "SET_DASHBOARD_PROJECT", dirName: null })
      expect(getState(hook)).toBe(s)
    })
  })

  // ── INIT_PENDING_SESSION ──────────────────────────────────────────

  describe("INIT_PENDING_SESSION", () => {
    it("sets pendingDirName and clears session", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      dispatch(hook, { type: "INIT_PENDING_SESSION", dirName: "new-session-dir", isMobile: false })

      const s = getState(hook)
      expect(s.pendingDirName).toBe("new-session-dir")
      expect(s.session).toBeNull()
      expect(s.sessionSource).toBeNull()
    })

    it("resets UI state", () => {
      const hook = renderState()
      dispatch(hook, { type: "JUMP_TO_TURN", index: 5 })
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "query" })
      dispatch(hook, { type: "SET_EXPAND_ALL", value: true })

      dispatch(hook, { type: "INIT_PENDING_SESSION", dirName: "d", isMobile: false })
      const s = getState(hook)
      expect(s.activeTurnIndex).toBeNull()
      expect(s.searchQuery).toBe("")
      expect(s.expandAll).toBe(false)
    })

    it("increments sessionChangeKey", () => {
      const hook = renderState()
      const before = getState(hook).sessionChangeKey
      dispatch(hook, { type: "INIT_PENDING_SESSION", dirName: "d", isMobile: false })
      expect(getState(hook).sessionChangeKey).toBe(before + 1)
    })

    it("sets mobileTab to chat on mobile", () => {
      const hook = renderState()
      dispatch(hook, { type: "INIT_PENDING_SESSION", dirName: "d", isMobile: true })
      expect(getState(hook).mobileTab).toBe("chat")
    })
  })

  // ── FINALIZE_SESSION ──────────────────────────────────────────────

  describe("FINALIZE_SESSION", () => {
    it("sets session and source and clears pendingDirName", () => {
      const hook = renderState()
      dispatch(hook, { type: "INIT_PENDING_SESSION", dirName: "d1", isMobile: false })
      const session = makeSession()
      const source = makeSource()
      dispatch(hook, { type: "FINALIZE_SESSION", session, source, isMobile: false })

      const s = getState(hook)
      expect(s.session).toBe(session)
      expect(s.sessionSource).toBe(source)
      expect(s.pendingDirName).toBeNull()
    })

    it("increments sessionChangeKey", () => {
      const hook = renderState()
      const before = getState(hook).sessionChangeKey
      dispatch(hook, { type: "FINALIZE_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).sessionChangeKey).toBe(before + 1)
    })

    it("sets mobileTab to chat on mobile", () => {
      const hook = renderState()
      dispatch(hook, { type: "FINALIZE_SESSION", session: makeSession(), source: makeSource(), isMobile: true })
      expect(getState(hook).mobileTab).toBe("chat")
    })

    it("resets UI state like LOAD_SESSION", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "abc" })
      dispatch(hook, { type: "SET_EXPAND_ALL", value: true })
      dispatch(hook, { type: "SELECT_TEAM", teamName: "t", isMobile: false })
      dispatch(hook, { type: "SET_DASHBOARD_PROJECT", dirName: "proj" })

      dispatch(hook, { type: "FINALIZE_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      const s = getState(hook)
      expect(s.searchQuery).toBe("")
      expect(s.expandAll).toBe(false)
      expect(s.selectedTeam).toBeNull()
      expect(s.mainView).toBe("sessions")
      expect(s.dashboardProject).toBeNull()
    })
  })

  // ── Reducer immutability ─────────────────────────────────────────

  describe("reducer immutability", () => {
    it("returns a new state reference on LOAD_SESSION", () => {
      const hook = renderState()
      const before = getState(hook)
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook)).not.toBe(before)
    })

    it("returns a new state reference on JUMP_TO_TURN", () => {
      const hook = renderState()
      const before = getState(hook)
      dispatch(hook, { type: "JUMP_TO_TURN", index: 5 })
      expect(getState(hook)).not.toBe(before)
    })

    it("returns a new state reference on TOGGLE_EXPAND_ALL", () => {
      const hook = renderState()
      const before = getState(hook)
      dispatch(hook, { type: "TOGGLE_EXPAND_ALL" })
      expect(getState(hook)).not.toBe(before)
    })

    it("returns same reference for no-op SET_SEARCH_QUERY", () => {
      const hook = renderState()
      const before = getState(hook)
      // initial searchQuery is ""
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "" })
      expect(getState(hook)).toBe(before)
    })

    it("returns same reference for no-op SET_LOADING_MEMBER", () => {
      const hook = renderState()
      const before = getState(hook)
      // initial loadingMember is null
      dispatch(hook, { type: "SET_LOADING_MEMBER", name: null })
      expect(getState(hook)).toBe(before)
    })

    it("returns same reference for no-op SET_SIDEBAR_TAB", () => {
      const hook = renderState()
      const before = getState(hook)
      // initial sidebarTab is "browse"
      dispatch(hook, { type: "SET_SIDEBAR_TAB", tab: "browse" })
      expect(getState(hook)).toBe(before)
    })

    it("returns same reference for no-op GUARD_MOBILE_TAB when already sessions", () => {
      const hook = renderState()
      const before = getState(hook)
      dispatch(hook, { type: "GUARD_MOBILE_TAB", hasSession: false, hasTeam: false })
      expect(getState(hook)).toBe(before)
    })
  })

  // ── Unknown action type ───────────────────────────────────────────

  describe("unknown action type", () => {
    it("returns same state for unknown action type", () => {
      const hook = renderState()
      const before = getState(hook)
      // @ts-expect-error - testing unknown action type
      dispatch(hook, { type: "UNKNOWN_ACTION" })
      expect(getState(hook)).toBe(before)
    })
  })

  // ── Sequential dispatches ─────────────────────────────────────────

  describe("sequential dispatches", () => {
    it("accumulates sessionChangeKey across multiple LOAD_SESSION dispatches", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).sessionChangeKey).toBe(3)
    })

    it("LOAD_SESSION then JUMP_TO_TURN then LOAD_SESSION resets activeTurnIndex", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      dispatch(hook, { type: "JUMP_TO_TURN", index: 7 })
      expect(getState(hook).activeTurnIndex).toBe(7)

      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).activeTurnIndex).toBeNull()
    })

    it("SET_SEARCH_QUERY -> SET_EXPAND_ALL -> TOGGLE_EXPAND_ALL chain", () => {
      const hook = renderState()
      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "test" })
      dispatch(hook, { type: "SET_EXPAND_ALL", value: true })
      dispatch(hook, { type: "TOGGLE_EXPAND_ALL" })

      expect(getState(hook).searchQuery).toBe("test")
      expect(getState(hook).expandAll).toBe(false)
    })

    it("SELECT_TEAM -> LOAD_SESSION_FROM_TEAM -> SWITCH_TEAM_MEMBER -> GO_HOME flow", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "team-a", isMobile: false })
      expect(getState(hook).mainView).toBe("teams")
      expect(getState(hook).selectedTeam).toBe("team-a")

      dispatch(hook, {
        type: "LOAD_SESSION_FROM_TEAM",
        session: makeSession(),
        source: makeSource(),
        memberName: "alice",
        isMobile: false,
      })
      expect(getState(hook).currentMemberName).toBe("alice")
      expect(getState(hook).mainView).toBe("sessions")

      dispatch(hook, {
        type: "SWITCH_TEAM_MEMBER",
        session: makeSession(),
        source: makeSource(),
        memberName: "bob",
      })
      expect(getState(hook).currentMemberName).toBe("bob")

      dispatch(hook, { type: "GO_HOME", isMobile: false })
      expect(getState(hook).currentMemberName).toBeNull()
      expect(getState(hook).session).toBeNull()
    })
  })

  // ── Complex flows ─────────────────────────────────────────────────

  describe("complex state flows", () => {
    it("supports full lifecycle: load -> navigate -> search -> go home", () => {
      const hook = renderState()
      dispatch(hook, { type: "LOAD_SESSION", session: makeSession(), source: makeSource(), isMobile: false })
      expect(getState(hook).session).not.toBeNull()

      dispatch(hook, { type: "JUMP_TO_TURN", index: 2 })
      expect(getState(hook).activeTurnIndex).toBe(2)

      dispatch(hook, { type: "SET_SEARCH_QUERY", value: "find" })
      expect(getState(hook).searchQuery).toBe("find")

      dispatch(hook, { type: "GO_HOME", isMobile: false })
      expect(getState(hook).session).toBeNull()
      expect(getState(hook).activeTurnIndex).toBeNull()
      expect(getState(hook).searchQuery).toBe("")
    })

    it("supports team flow: select team -> load member -> switch -> back", () => {
      const hook = renderState()
      dispatch(hook, { type: "SELECT_TEAM", teamName: "my-team", isMobile: false })
      expect(getState(hook).mainView).toBe("teams")

      dispatch(hook, { type: "LOAD_SESSION_FROM_TEAM", session: makeSession(), source: makeSource(), memberName: "m1", isMobile: false })
      expect(getState(hook).currentMemberName).toBe("m1")

      dispatch(hook, { type: "SWITCH_TEAM_MEMBER", session: makeSession(), source: makeSource(), memberName: "m2" })
      expect(getState(hook).currentMemberName).toBe("m2")

      dispatch(hook, { type: "GO_HOME", isMobile: false })
      expect(getState(hook).currentMemberName).toBeNull()
    })

    it("supports pending session flow: init -> finalize", () => {
      const hook = renderState()
      dispatch(hook, { type: "INIT_PENDING_SESSION", dirName: "new-dir", isMobile: true })
      expect(getState(hook).pendingDirName).toBe("new-dir")
      expect(getState(hook).session).toBeNull()
      expect(getState(hook).mobileTab).toBe("chat")

      const session = makeSession()
      const source = makeSource()
      dispatch(hook, { type: "FINALIZE_SESSION", session, source, isMobile: true })
      expect(getState(hook).session).toBe(session)
      expect(getState(hook).pendingDirName).toBeNull()
    })
  })
})
