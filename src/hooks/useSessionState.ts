import { useReducer } from "react"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { MobileTab } from "@/components/MobileNav"

export interface SessionState {
  session: ParsedSession | null
  sessionSource: SessionSource | null
  activeTurnIndex: number | null
  activeToolCallId: string | null
  searchQuery: string
  expandAll: boolean
  sessionChangeKey: number
  currentMemberName: string | null
  loadingMember: string | null
  mainView: "sessions" | "teams"
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

const initialState: SessionState = {
  session: null,
  sessionSource: null,
  activeTurnIndex: null,
  activeToolCallId: null,
  searchQuery: "",
  expandAll: false,
  sessionChangeKey: 0,
  currentMemberName: null,
  loadingMember: null,
  mainView: "sessions",
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
      return { ...state, searchQuery: action.value }

    case "SET_EXPAND_ALL":
      return { ...state, expandAll: action.value }

    case "TOGGLE_EXPAND_ALL":
      return { ...state, expandAll: !state.expandAll }

    case "SET_MOBILE_TAB":
      return {
        ...state,
        mobileTab: action.tab,
        sidebarTab: action.tab === "teams" && !state.selectedTeam ? "teams" : state.sidebarTab,
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
      return { ...state, loadingMember: action.name }

    case "SET_SIDEBAR_TAB":
      return { ...state, sidebarTab: action.tab }

    case "SET_DASHBOARD_PROJECT":
      return { ...state, dashboardProject: action.dirName }

    default:
      return state
  }
}

export function useSessionState() {
  return useReducer(sessionReducer, initialState)
}
