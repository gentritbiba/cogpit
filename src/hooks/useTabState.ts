import { useReducer, useEffect } from "react"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"

// ── Types ───────────────────────────────────────────────────────────────

export interface TabSnapshot {
  id: string // `${dirName}/${fileName}` or uuid for pending
  dirName: string
  fileName: string | null // null for pending sessions
  label: string // first user message or project name
  projectName: string
  // Frozen UI state (captured on switch-away)
  activeTurnIndex: number | null
  activeToolCallId: string | null
  searchQuery: string
  expandAll: boolean
  scrollTop: number
  // Activity
  hasUnreadActivity: boolean
  lastKnownTurnCount: number
  // Cache
  cachedSession: ParsedSession | null
  cachedSource: SessionSource | null
  // Pending
  pendingDirName: string | null
  pendingCwd: string | null
}

export interface TabState {
  tabs: TabSnapshot[]
  activeTabId: string | null
}

export type TabAction =
  | {
      type: "OPEN_TAB"
      session: ParsedSession | null
      source: SessionSource | null
      label: string
      pendingDirName?: string | null
      pendingCwd?: string | null
    }
  | { type: "CLOSE_TAB"; tabId: string }
  | { type: "SWITCH_TAB"; tabId: string }
  | {
      type: "SNAPSHOT_ACTIVE"
      activeTurnIndex: number | null
      activeToolCallId: string | null
      searchQuery: string
      expandAll: boolean
      scrollTop: number
      session: ParsedSession | null
      source: SessionSource | null
    }
  | { type: "MARK_ACTIVITY"; tabId: string; turnCount: number }
  | { type: "CLEAR_ACTIVITY"; tabId: string }
  | { type: "UPDATE_TAB_META"; tabId: string; updates: Partial<TabSnapshot> }

// ── Constants ───────────────────────────────────────────────────────────

const STORAGE_KEY = "cogpit-tab-state"

let pendingCounter = 0

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTabId(source: SessionSource | null, pendingDirName?: string | null): string {
  if (source) return `${source.dirName}/${source.fileName}`
  return `pending-${pendingDirName ?? "unknown"}-${++pendingCounter}`
}

function serializeForStorage(state: TabState): string {
  const stripped = {
    tabs: state.tabs.map(({ cachedSession, cachedSource, ...rest }) => rest),
    activeTabId: state.activeTabId,
  }
  return JSON.stringify(stripped)
}

function loadFromStorage(): TabState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as TabState
    if (!Array.isArray(parsed.tabs)) return null
    // Restore null caches
    parsed.tabs = parsed.tabs.map((tab) => ({
      ...tab,
      cachedSession: tab.cachedSession ?? null,
      cachedSource: tab.cachedSource ?? null,
    }))
    return parsed
  } catch {
    return null
  }
}

// ── Reducer ─────────────────────────────────────────────────────────────

const initialState: TabState = {
  tabs: [],
  activeTabId: null,
}

function tabReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case "OPEN_TAB": {
      const id = makeTabId(action.source, action.pendingDirName)
      // If tab already exists, just switch to it
      const existing = state.tabs.find((t) => t.id === id)
      if (existing) {
        if (state.activeTabId === id) return state
        return { ...state, activeTabId: id }
      }
      const newTab: TabSnapshot = {
        id,
        dirName: action.source?.dirName ?? action.pendingDirName ?? "",
        fileName: action.source?.fileName ?? null,
        label: action.label,
        projectName: action.source?.dirName ?? action.pendingDirName ?? "",
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,
        scrollTop: 0,
        hasUnreadActivity: false,
        lastKnownTurnCount: 0,
        cachedSession: action.session,
        cachedSource: action.source,
        pendingDirName: action.pendingDirName ?? null,
        pendingCwd: action.pendingCwd ?? null,
      }
      return {
        tabs: [...state.tabs, newTab],
        activeTabId: id,
      }
    }

    case "CLOSE_TAB": {
      const idx = state.tabs.findIndex((t) => t.id === action.tabId)
      if (idx === -1) return state
      const newTabs = state.tabs.filter((t) => t.id !== action.tabId)
      let newActiveId = state.activeTabId
      if (state.activeTabId === action.tabId) {
        if (newTabs.length === 0) {
          newActiveId = null
        } else {
          // Activate next tab, or previous if closing the last one
          const nextIdx = Math.min(idx, newTabs.length - 1)
          newActiveId = newTabs[nextIdx].id
        }
      }
      return { tabs: newTabs, activeTabId: newActiveId }
    }

    case "SWITCH_TAB": {
      if (!state.tabs.some((t) => t.id === action.tabId)) return state
      if (state.activeTabId === action.tabId) return state
      return { ...state, activeTabId: action.tabId }
    }

    case "SNAPSHOT_ACTIVE": {
      if (!state.activeTabId) return state
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId
            ? {
                ...tab,
                activeTurnIndex: action.activeTurnIndex,
                activeToolCallId: action.activeToolCallId,
                searchQuery: action.searchQuery,
                expandAll: action.expandAll,
                scrollTop: action.scrollTop,
                cachedSession: action.session,
                cachedSource: action.source,
              }
            : tab
        ),
      }
    }

    case "MARK_ACTIVITY": {
      // Don't mark the active tab
      if (action.tabId === state.activeTabId) return state
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, hasUnreadActivity: true, lastKnownTurnCount: action.turnCount } : tab
        ),
      }
    }

    case "CLEAR_ACTIVITY": {
      return {
        ...state,
        tabs: state.tabs.map((tab) => (tab.id === action.tabId ? { ...tab, hasUnreadActivity: false } : tab)),
      }
    }

    case "UPDATE_TAB_META": {
      const oldTab = state.tabs.find((t) => t.id === action.tabId)
      if (!oldTab) return state
      const newId = action.updates.id
      const needsActiveUpdate = newId && state.activeTabId === action.tabId
      return {
        tabs: state.tabs.map((tab) => (tab.id === action.tabId ? { ...tab, ...action.updates } : tab)),
        activeTabId: needsActiveUpdate ? newId : state.activeTabId,
      }
    }

    default:
      return state
  }
}

// ── Hook ────────────────────────────────────────────────────────────────

export function useTabState(): [TabState, React.Dispatch<TabAction>] {
  const restored = loadFromStorage()
  const [state, dispatch] = useReducer(tabReducer, restored ?? initialState)

  // Persist to localStorage on every change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, serializeForStorage(state))
  }, [state])

  return [state, dispatch]
}
