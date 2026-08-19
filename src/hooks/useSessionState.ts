import { useReducer } from "react"
import { prependTurns } from "@/lib/timelinePaging"
import type { AgentKind } from "@/lib/sessionSource"
import type { ParsedSession, Turn } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { MobileTab } from "@/components/MobileNav"

export interface SessionState {
  session: ParsedSession | null
  /**
   * Turns exactly as the live pipeline last emitted them. Sessions open
   * bottom-first, so this is only the loaded tail window — never the history
   * paged in above it.
   */
  windowTurns: Turn[]
  /** Older pages loaded by scroll-up paging, oldest first, unstitched. */
  olderTurns: Turn[]
  sessionSource: SessionSource | null
  /** dirName of a pending (not-yet-created) session, set before first message */
  pendingDirName: string | null
  /** Real filesystem path for the pending session (avoids lossy dirNameToPath) */
  pendingCwd: string | null
  activeTurnIndex: number | null
  activeToolCallId: string | null
  searchQuery: string
  expandAll: boolean
  sessionChangeKey: number
  currentMemberName: string | null
  loadingMember: string | null
  mainView: "sessions" | "config" | "mission"
  configFilePath: string | null
  mobileTab: MobileTab
  dashboardProject: string | null
}

export type SessionAction =
  | { type: "LOAD_SESSION"; session: ParsedSession; source: SessionSource; isMobile: boolean }
  | { type: "GO_HOME"; isMobile: boolean }
  | { type: "SWITCH_TEAM_MEMBER"; session: ParsedSession; source: SessionSource; memberName: string }
  | { type: "JUMP_TO_TURN"; index: number; toolCallId?: string }
  | { type: "SET_SEARCH_QUERY"; value: string }
  | { type: "SET_EXPAND_ALL"; value: boolean }
  | { type: "TOGGLE_EXPAND_ALL" }
  | { type: "SET_MOBILE_TAB"; tab: MobileTab }
  | { type: "UPDATE_SESSION"; session: ParsedSession }
  | { type: "SET_OLDER_TURNS"; turns: Turn[] }
  | { type: "RELOAD_SESSION_CONTENT"; session: ParsedSession; source: SessionSource }
  | { type: "SET_CURRENT_MEMBER_NAME"; name: string | null }
  | { type: "GUARD_MOBILE_TAB"; hasSession: boolean }
  | { type: "SET_LOADING_MEMBER"; name: string | null }
  | { type: "SET_DASHBOARD_PROJECT"; dirName: string | null }
  | { type: "INIT_PENDING_SESSION"; dirName: string; cwd?: string; isMobile: boolean }
  | { type: "FINALIZE_SESSION"; session: ParsedSession; source: SessionSource; isMobile: boolean }
  | { type: "OPEN_CONFIG"; filePath?: string }
  | { type: "CLOSE_CONFIG" }
  | { type: "OPEN_MISSION" }
  | { type: "CLOSE_MISSION" }

const initialState: SessionState = {
  session: null,
  windowTurns: [],
  olderTurns: [],
  sessionSource: null,
  pendingDirName: null,
  pendingCwd: null,
  activeTurnIndex: null,
  activeToolCallId: null,
  searchQuery: "",
  expandAll: false,
  sessionChangeKey: 0,
  currentMemberName: null,
  loadingMember: null,
  mainView: "sessions",
  configFilePath: null,
  mobileTab: "sessions",
  dashboardProject: null,
}

/**
 * Rebuilds the rendered session from the live window plus the history paged in
 * above it. The live pipeline re-emits only its own window on every appended
 * line, so the paged-in turns have to be re-applied each time or one streamed
 * line wipes everything the user scrolled up to. `prependTurns` dedupes by id
 * and re-stitches the turn a page boundary cut in half, so replaying it is
 * safe.
 */
function composeSession(
  session: ParsedSession,
  windowTurns: Turn[],
  olderTurns: Turn[],
  agentKind?: AgentKind,
): ParsedSession {
  const turns = prependTurns(windowTurns, olderTurns, agentKind)
  return turns === session.turns ? session : { ...session, turns }
}

/** Opening a different session discards the paging state of the previous one. */
function openSession(session: ParsedSession | null) {
  return { session, windowTurns: session?.turns ?? [], olderTurns: [] }
}

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "LOAD_SESSION":
      return {
        ...state,
        ...openSession(action.session),
        sessionSource: action.source,
        pendingDirName: null,
        pendingCwd: null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,

        mainView: "sessions",
        currentMemberName: null,
        dashboardProject: null,
        sessionChangeKey: state.sessionChangeKey + 1,
        mobileTab: action.isMobile ? "chat" : state.mobileTab,
      }

    case "GO_HOME":
      return {
        ...state,
        ...openSession(null),
        sessionSource: null,
        pendingDirName: null,
        pendingCwd: null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,

        mainView: "sessions",
        currentMemberName: null,
        dashboardProject: null,
        mobileTab: action.isMobile ? "sessions" : state.mobileTab,
      }

    case "SWITCH_TEAM_MEMBER":
      return {
        ...state,
        ...openSession(action.session),
        sessionSource: action.source,
        activeTurnIndex: null,
        searchQuery: "",
        expandAll: false,
        currentMemberName: action.memberName,
        sessionChangeKey: state.sessionChangeKey + 1,
      }

    case "JUMP_TO_TURN":
      return {
        ...state,
        activeTurnIndex: action.index,
        activeToolCallId: action.toolCallId ?? null,
      }

    case "SET_SEARCH_QUERY":
      if (state.searchQuery === action.value) return state
      return { ...state, searchQuery: action.value }

    case "SET_EXPAND_ALL":
      if (state.expandAll === action.value) return state
      return { ...state, expandAll: action.value }

    case "TOGGLE_EXPAND_ALL":
      return { ...state, expandAll: !state.expandAll }

    case "SET_MOBILE_TAB":
      if (state.mobileTab === action.tab) return state
      return { ...state, mobileTab: action.tab }

    case "UPDATE_SESSION":
      return {
        ...state,
        windowTurns: action.session.turns,
        session: composeSession(
          action.session,
          action.session.turns,
          state.olderTurns,
          state.sessionSource?.agentKind,
        ),
      }

    case "SET_OLDER_TURNS": {
      if (!state.session || action.turns === state.olderTurns) return state
      return {
        ...state,
        olderTurns: action.turns,
        session: composeSession(
          state.session,
          state.windowTurns,
          action.turns,
          state.sessionSource?.agentKind,
        ),
      }
    }

    case "RELOAD_SESSION_CONTENT":
      return {
        ...state,
        ...openSession(action.session),
        sessionSource: action.source,
        sessionChangeKey: state.sessionChangeKey + 1,
      }

    case "SET_CURRENT_MEMBER_NAME":
      if (state.currentMemberName === action.name) return state
      return { ...state, currentMemberName: action.name }

    case "GUARD_MOBILE_TAB": {
      let tab = state.mobileTab
      if (!action.hasSession && (tab === "stats" || tab === "chat")) {
        tab = "sessions"
      }
      return tab !== state.mobileTab ? { ...state, mobileTab: tab } : state
    }

    case "SET_LOADING_MEMBER":
      if (state.loadingMember === action.name) return state
      return { ...state, loadingMember: action.name }

    case "SET_DASHBOARD_PROJECT":
      if (state.dashboardProject === action.dirName) return state
      return { ...state, dashboardProject: action.dirName }

    case "INIT_PENDING_SESSION":
      return {
        ...state,
        ...openSession(null),
        sessionSource: null,
        pendingDirName: action.dirName,
        pendingCwd: action.cwd ?? null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,
        mainView: "sessions",
        currentMemberName: null,
        dashboardProject: null,
        sessionChangeKey: state.sessionChangeKey + 1,
        mobileTab: action.isMobile ? "chat" : state.mobileTab,
      }

    case "FINALIZE_SESSION":
      return {
        ...state,
        ...openSession(action.session),
        sessionSource: action.source,
        pendingDirName: null,
        pendingCwd: null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,
        mainView: "sessions",
        currentMemberName: null,
        dashboardProject: null,
        sessionChangeKey: state.sessionChangeKey + 1,
        mobileTab: action.isMobile ? "chat" : state.mobileTab,
      }

    case "OPEN_CONFIG":
      return { ...state, mainView: "config", configFilePath: action.filePath ?? null }

    case "CLOSE_CONFIG":
      return { ...state, mainView: "sessions", configFilePath: null }

    case "OPEN_MISSION":
      return { ...state, mainView: "mission" }

    case "CLOSE_MISSION":
      return { ...state, mainView: "sessions" }

    default:
      return state
  }
}

export function useSessionState() {
  return useReducer(sessionReducer, initialState)
}
