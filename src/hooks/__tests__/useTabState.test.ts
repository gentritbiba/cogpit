import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useTabState } from "@/hooks/useTabState"
import type { TabState, TabSnapshot } from "@/hooks/useTabState"
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

function makeTab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    id: "test-dir/test.jsonl",
    dirName: "test-dir",
    fileName: "test.jsonl",
    label: "Test Session",
    projectName: "test-dir",
    activeTurnIndex: null,
    activeToolCallId: null,
    searchQuery: "",
    expandAll: false,
    scrollTop: 0,
    hasUnreadActivity: false,
    lastKnownTurnCount: 0,
    cachedSession: null,
    cachedSource: null,
    pendingDirName: null,
    pendingCwd: null,
    ...overrides,
  }
}

function renderState() {
  return renderHook(() => useTabState())
}

function getState(hook: ReturnType<typeof renderState>): TabState {
  return hook.result.current[0]
}

function dispatch(hook: ReturnType<typeof renderState>, ...actions: Parameters<typeof hook.result.current[1]>) {
  return act(() => hook.result.current[1](...actions))
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("useTabState", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe("initial state", () => {
    it("starts with empty tabs", () => {
      const hook = renderState()
      expect(getState(hook).tabs).toEqual([])
    })

    it("starts with null activeTabId", () => {
      const hook = renderState()
      expect(getState(hook).activeTabId).toBeNull()
    })
  })

  describe("OPEN_TAB", () => {
    it("adds a new tab and makes it active", () => {
      const hook = renderState()
      const session = makeSession()
      const source = makeSource()

      dispatch(hook, {
        type: "OPEN_TAB",
        session,
        source,
        label: "My Session",
      })

      const state = getState(hook)
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].id).toBe("test-dir/test.jsonl")
      expect(state.tabs[0].label).toBe("My Session")
      expect(state.tabs[0].dirName).toBe("test-dir")
      expect(state.tabs[0].fileName).toBe("test.jsonl")
      expect(state.activeTabId).toBe("test-dir/test.jsonl")
    })

    it("switches to existing tab if session is already open", () => {
      const hook = renderState()
      const session = makeSession()
      const source = makeSource()

      dispatch(hook, { type: "OPEN_TAB", session, source, label: "Session 1" })
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "other" }), label: "Session 2" })
      // Open same session again
      dispatch(hook, { type: "OPEN_TAB", session, source, label: "Session 1 Again" })

      const state = getState(hook)
      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabId).toBe("test-dir/test.jsonl")
    })

    it("caches session and source", () => {
      const hook = renderState()
      const session = makeSession()
      const source = makeSource()

      dispatch(hook, { type: "OPEN_TAB", session, source, label: "My Session" })

      const tab = getState(hook).tabs[0]
      expect(tab.cachedSession).toBe(session)
      expect(tab.cachedSource).toBe(source)
    })

    it("opens pending tab with null fileName", () => {
      const hook = renderState()

      dispatch(hook, {
        type: "OPEN_TAB",
        session: null,
        source: null,
        label: "New Session",
        pendingDirName: "my-project",
        pendingCwd: "/home/user/my-project",
      })

      const state = getState(hook)
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].fileName).toBeNull()
      expect(state.tabs[0].pendingDirName).toBe("my-project")
      expect(state.tabs[0].pendingCwd).toBe("/home/user/my-project")
      expect(state.activeTabId).toBe(state.tabs[0].id)
    })
  })

  describe("CLOSE_TAB", () => {
    it("removes the specified tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource(), label: "S1" })
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d2" }), label: "S2" })

      dispatch(hook, { type: "CLOSE_TAB", tabId: "test-dir/test.jsonl" })

      const state = getState(hook)
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].id).toBe("d2/test.jsonl")
    })

    it("activates the next tab when closing active tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d1" }), label: "S1" })
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d2" }), label: "S2" })
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d3" }), label: "S3" })
      // Active is d3, switch to d2
      dispatch(hook, { type: "SWITCH_TAB", tabId: "d2/test.jsonl" })

      dispatch(hook, { type: "CLOSE_TAB", tabId: "d2/test.jsonl" })

      const state = getState(hook)
      expect(state.tabs).toHaveLength(2)
      // Should activate next tab (d3) or previous (d1)
      expect(state.activeTabId).not.toBeNull()
      expect(state.activeTabId).not.toBe("d2/test.jsonl")
    })

    it("activates the previous tab when closing the last tab in the list", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d1" }), label: "S1" })
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d2" }), label: "S2" })
      // Active is d2 (last)
      dispatch(hook, { type: "CLOSE_TAB", tabId: "d2/test.jsonl" })

      const state = getState(hook)
      expect(state.activeTabId).toBe("d1/test.jsonl")
    })

    it("sets activeTabId to null when closing the only tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource(), label: "S1" })
      dispatch(hook, { type: "CLOSE_TAB", tabId: "test-dir/test.jsonl" })

      const state = getState(hook)
      expect(state.tabs).toHaveLength(0)
      expect(state.activeTabId).toBeNull()
    })
  })

  describe("SWITCH_TAB", () => {
    it("changes the active tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d1" }), label: "S1" })
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d2" }), label: "S2" })

      dispatch(hook, { type: "SWITCH_TAB", tabId: "d1/test.jsonl" })

      expect(getState(hook).activeTabId).toBe("d1/test.jsonl")
    })

    it("is a no-op if tab does not exist", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource(), label: "S1" })
      const before = getState(hook)

      dispatch(hook, { type: "SWITCH_TAB", tabId: "nonexistent/tab" })

      expect(getState(hook)).toBe(before)
    })
  })

  describe("SNAPSHOT_ACTIVE", () => {
    it("saves UI state to the active tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource(), label: "S1" })

      dispatch(hook, {
        type: "SNAPSHOT_ACTIVE",
        activeTurnIndex: 5,
        activeToolCallId: "tool-1",
        searchQuery: "hello",
        expandAll: true,
        scrollTop: 300,
        session: makeSession({ sessionId: "updated" }),
        source: makeSource(),
      })

      const tab = getState(hook).tabs[0]
      expect(tab.activeTurnIndex).toBe(5)
      expect(tab.activeToolCallId).toBe("tool-1")
      expect(tab.searchQuery).toBe("hello")
      expect(tab.expandAll).toBe(true)
      expect(tab.scrollTop).toBe(300)
      expect(tab.cachedSession?.sessionId).toBe("updated")
    })

    it("is a no-op if no active tab", () => {
      const hook = renderState()
      const before = getState(hook)

      dispatch(hook, {
        type: "SNAPSHOT_ACTIVE",
        activeTurnIndex: 0,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,
        scrollTop: 0,
        session: null,
        source: null,
      })

      expect(getState(hook)).toBe(before)
    })
  })

  describe("MARK_ACTIVITY", () => {
    it("sets hasUnreadActivity on the specified tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d1" }), label: "S1" })
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d2" }), label: "S2" })

      dispatch(hook, { type: "MARK_ACTIVITY", tabId: "d1/test.jsonl", turnCount: 3 })

      const tab = getState(hook).tabs.find((t) => t.id === "d1/test.jsonl")
      expect(tab?.hasUnreadActivity).toBe(true)
      expect(tab?.lastKnownTurnCount).toBe(3)
    })

    it("does not mark the active tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource(), label: "S1" })

      dispatch(hook, { type: "MARK_ACTIVITY", tabId: "test-dir/test.jsonl", turnCount: 3 })

      const tab = getState(hook).tabs[0]
      expect(tab.hasUnreadActivity).toBe(false)
    })
  })

  describe("CLEAR_ACTIVITY", () => {
    it("clears hasUnreadActivity on the specified tab", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d1" }), label: "S1" })
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource({ dirName: "d2" }), label: "S2" })
      dispatch(hook, { type: "MARK_ACTIVITY", tabId: "d1/test.jsonl", turnCount: 3 })

      dispatch(hook, { type: "CLEAR_ACTIVITY", tabId: "d1/test.jsonl" })

      const tab = getState(hook).tabs.find((t) => t.id === "d1/test.jsonl")
      expect(tab?.hasUnreadActivity).toBe(false)
    })
  })

  describe("UPDATE_TAB_META", () => {
    it("updates tab label and fileName", () => {
      const hook = renderState()
      dispatch(hook, {
        type: "OPEN_TAB",
        session: null,
        source: null,
        label: "New Session",
        pendingDirName: "my-project",
        pendingCwd: "/home/user/my-project",
      })
      const tabId = getState(hook).tabs[0].id

      dispatch(hook, {
        type: "UPDATE_TAB_META",
        tabId,
        updates: { fileName: "real-session.jsonl", label: "Actual Session", id: "my-project/real-session.jsonl", pendingDirName: null, pendingCwd: null },
      })

      const tab = getState(hook).tabs[0]
      expect(tab.fileName).toBe("real-session.jsonl")
      expect(tab.label).toBe("Actual Session")
      expect(tab.id).toBe("my-project/real-session.jsonl")
      expect(tab.pendingDirName).toBeNull()
    })

    it("updates activeTabId when the active tab's id changes", () => {
      const hook = renderState()
      dispatch(hook, {
        type: "OPEN_TAB",
        session: null,
        source: null,
        label: "New Session",
        pendingDirName: "my-project",
        pendingCwd: "/home/user/my-project",
      })
      const oldId = getState(hook).tabs[0].id

      dispatch(hook, {
        type: "UPDATE_TAB_META",
        tabId: oldId,
        updates: { id: "my-project/real-session.jsonl" },
      })

      expect(getState(hook).activeTabId).toBe("my-project/real-session.jsonl")
    })
  })

  describe("localStorage persistence", () => {
    const STORAGE_KEY = "cogpit-tab-state"

    it("saves tab state to localStorage on change", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource(), label: "S1" })

      const stored = localStorage.getItem(STORAGE_KEY)
      expect(stored).not.toBeNull()
      const parsed = JSON.parse(stored!)
      expect(parsed.tabs).toHaveLength(1)
      expect(parsed.activeTabId).toBe("test-dir/test.jsonl")
    })

    it("excludes cachedSession and cachedSource from serialization", () => {
      const hook = renderState()
      dispatch(hook, { type: "OPEN_TAB", session: makeSession(), source: makeSource(), label: "S1" })

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
      expect(stored.tabs[0].cachedSession).toBeUndefined()
      expect(stored.tabs[0].cachedSource).toBeUndefined()
    })

    it("restores tab state from localStorage on init", () => {
      const savedState = {
        tabs: [makeTab({ id: "restored-dir/restored.jsonl", dirName: "restored-dir", fileName: "restored.jsonl", label: "Restored" })],
        activeTabId: "restored-dir/restored.jsonl",
      }
      // Remove cachedSession/cachedSource to simulate real storage
      const serialized = JSON.parse(JSON.stringify(savedState))
      delete serialized.tabs[0].cachedSession
      delete serialized.tabs[0].cachedSource
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized))

      const hook = renderState()
      const state = getState(hook)
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].id).toBe("restored-dir/restored.jsonl")
      expect(state.tabs[0].label).toBe("Restored")
      expect(state.tabs[0].cachedSession).toBeNull()
      expect(state.tabs[0].cachedSource).toBeNull()
      expect(state.activeTabId).toBe("restored-dir/restored.jsonl")
    })

    it("falls back to empty state on invalid localStorage", () => {
      localStorage.setItem(STORAGE_KEY, "corrupted{{{")

      const hook = renderState()
      const state = getState(hook)
      expect(state.tabs).toEqual([])
      expect(state.activeTabId).toBeNull()
    })
  })
})
