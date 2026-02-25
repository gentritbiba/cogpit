import { useReducer } from "react"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { MobileTab } from "@/components/MobileNav"

export interface SessionState {
  session: ParsedSession | null
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
  mainView: "sessions" | "teams" | "config"
  configFilePath: string | null
  selectedTeam: string | null
  sidebarTab: "browse" | "teams"
  mobileTab: MobileTab
  dashboardProject: string | null
}

export type SessionAction =
  | { type: "LOAD_SESSION"; session: ParsedSession; source: SessionSource; isMobile: boolean }
  | { type: "GO_HOME"; isMobile: boolean }
  | { type: "LOAD_SESSION_FROM_TEAM"; session: ParsedSession; source: SessionSource; memberName?: string; isMobile: boolean }
  | { type: "SWITCH_TEAM_MEMBER"; session: ParsedSession; source: SessionSource; memberName: string }
  | { type: "SELECT_TEAM"; teamName: string; isMobile: boolean }
  | { type: "BACK_FROM_TEAM"; isMobile: boolean }
  | { type: "JUMP_TO_TURN"; index: number; toolCallId?: string }
  | { type: "SET_SEARCH_QUERY"; value: string }
  | { type: "SET_EXPAND_ALL"; value: boolean }
  | { type: "TOGGLE_EXPAND_ALL" }
  | { type: "SET_MOBILE_TAB"; tab: MobileTab }
  | { type: "UPDATE_SESSION"; session: ParsedSession }
  | { type: "RELOAD_SESSION_CONTENT"; session: ParsedSession; source: SessionSource }
  | { type: "SET_CURRENT_MEMBER_NAME"; name: string | null }
  | { type: "GUARD_MOBILE_TAB"; hasSession: boolean; hasTeam: boolean }
  | { type: "SET_LOADING_MEMBER"; name: string | null }
  | { type: "SET_SIDEBAR_TAB"; tab: "browse" | "teams" }
  | { type: "SET_DASHBOARD_PROJECT"; dirName: string | null }
  | { type: "INIT_PENDING_SESSION"; dirName: string; cwd?: string; isMobile: boolean }
  | { type: "FINALIZE_SESSION"; session: ParsedSession; source: SessionSource; isMobile: boolean }
  | { type: "OPEN_CONFIG"; filePath?: string }
  | { type: "CLOSE_CONFIG" }

const initialState: SessionState = {
  session: null,
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
  selectedTeam: null,
  sidebarTab: "browse",
  mobileTab: "sessions",
  dashboardProject: null,
}

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "LOAD_SESSION":
      return {
        ...state,
        session: action.session,
        sessionSource: action.source,
        pendingDirName: null,
        pendingCwd: null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,

        mainView: "sessions",
        selectedTeam: null,
        currentMemberName: null,
        dashboardProject: null,
        sessionChangeKey: state.sessionChangeKey + 1,
        mobileTab: action.isMobile ? "chat" : state.mobileTab,
      }

    case "GO_HOME":
      return {
        ...state,
        session: null,
        sessionSource: null,
        pendingDirName: null,
        pendingCwd: null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,

        mainView: "sessions",
        selectedTeam: null,
        currentMemberName: null,
        dashboardProject: null,
        mobileTab: action.isMobile ? "sessions" : state.mobileTab,
      }

    case "LOAD_SESSION_FROM_TEAM":
      return {
        ...state,
        session: action.session,
        sessionSource: action.source,
        activeTurnIndex: null,
        searchQuery: "",
        expandAll: false,
        mainView: "sessions",
        selectedTeam: null,
        currentMemberName: action.memberName ?? state.currentMemberName,
        sessionChangeKey: state.sessionChangeKey + 1,
        mobileTab: action.isMobile ? "chat" : state.mobileTab,
      }

    case "SWITCH_TEAM_MEMBER":
      return {
        ...state,
        session: action.session,
        sessionSource: action.source,
        activeTurnIndex: null,
        searchQuery: "",
        expandAll: false,
        currentMemberName: action.memberName,
        sessionChangeKey: state.sessionChangeKey + 1,
      }

    case "SELECT_TEAM":
      return {
        ...state,
        selectedTeam: action.teamName,
        mainView: "teams",
        mobileTab: action.isMobile ? "teams" : state.mobileTab,
      }

    case "BACK_FROM_TEAM":
      return {
        ...state,
        selectedTeam: null,
        mainView: "sessions",
        mobileTab: action.isMobile ? "sessions" : state.mobileTab,
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

    case "SET_MOBILE_TAB": {
      const newSidebarTab = action.tab === "teams" && !state.selectedTeam ? "teams" : state.sidebarTab
      if (state.mobileTab === action.tab && state.sidebarTab === newSidebarTab) return state
      return { ...state, mobileTab: action.tab, sidebarTab: newSidebarTab }
    }

    case "UPDATE_SESSION":
      return { ...state, session: action.session }

    case "RELOAD_SESSION_CONTENT":
      return {
        ...state,
        session: action.session,
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
      if (!action.hasTeam && tab === "teams") {
        tab = "sessions"
      }
      return tab !== state.mobileTab ? { ...state, mobileTab: tab } : state
    }

    case "SET_LOADING_MEMBER":
      if (state.loadingMember === action.name) return state
      return { ...state, loadingMember: action.name }

    case "SET_SIDEBAR_TAB":
      if (state.sidebarTab === action.tab) return state
      return { ...state, sidebarTab: action.tab }

    case "SET_DASHBOARD_PROJECT":
      if (state.dashboardProject === action.dirName) return state
      return { ...state, dashboardProject: action.dirName }

    case "INIT_PENDING_SESSION":
      return {
        ...state,
        session: null,
        sessionSource: null,
        pendingDirName: action.dirName,
        pendingCwd: action.cwd ?? null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,
        mainView: "sessions",
        selectedTeam: null,
        currentMemberName: null,
        dashboardProject: null,
        sessionChangeKey: state.sessionChangeKey + 1,
        mobileTab: action.isMobile ? "chat" : state.mobileTab,
      }

    case "FINALIZE_SESSION":
      return {
        ...state,
        session: action.session,
        sessionSource: action.source,
        pendingDirName: null,
        pendingCwd: null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,
        mainView: "sessions",
        selectedTeam: null,
        currentMemberName: null,
        dashboardProject: null,
        sessionChangeKey: state.sessionChangeKey + 1,
        mobileTab: action.isMobile ? "chat" : state.mobileTab,
      }

    case "OPEN_CONFIG":
      return { ...state, mainView: "config", configFilePath: action.filePath ?? null }

    case "CLOSE_CONFIG":
      return { ...state, mainView: "sessions", configFilePath: null }

    default:
      return state
  }
}

export function useSessionState() {
  return useReducer(sessionReducer, initialState)
}
