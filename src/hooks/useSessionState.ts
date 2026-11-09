import { useState } from "react"
import { prependTurns } from "@/lib/timelinePaging"
import { createStore, shallowEqual, useStoreSelector, type Store } from "@/lib/store"
import type { AgentKind } from "@/lib/agents"
import type { Turn } from "../../shared/session/types"
import type { SessionView } from "../../shared/session/sessionDigest"
import type { SessionSource } from "@/lib/sessionSource"

export type MobileTab = "chat" | "sessions" | "workspace"

/** "extension" is a main view an edition registers, named by `extensionViewId`. */
export type MainView = "sessions" | "config" | "mission" | "extension"

export interface SessionState {
  session: SessionView | null
  /**
   * Turns exactly as the live pipeline last emitted them. Sessions open
   * bottom-first, so this is only the loaded tail window — never the history
   * paged in above it.
   */
  windowTurns: Turn[]
  /** Older pages loaded by scroll-up paging, oldest first, unstitched. */
  olderTurns: Turn[]
  /**
   * Whether the merge of the older pages reached past the window's first turn,
   * or left a message or question open that a streamed turn could answer
   * across the seam. While it holds, every update merges the pages again;
   * otherwise an update replaces only the window turns that changed.
   */
  seamOpen: boolean
  sessionSource: SessionSource | null
  /** dirName of a pending (not-yet-created) session, set before first message */
  pendingDirName: string | null
  /** Real filesystem path for the pending session (avoids lossy dirNameToPath) */
  pendingCwd: string | null
  activeTurnIndex: number | null
  activeToolCallId: string | null
  searchQuery: string
  expandAll: boolean
  expandToolPayloads: boolean
  sessionChangeKey: number
  currentMemberName: string | null
  loadingMember: string | null
  mainView: MainView
  /** The edition main view on screen; read only while `mainView` is "extension". */
  extensionViewId: string | null
  configFilePath: string | null
  mobileTab: MobileTab
  dashboardProject: string | null
}

/** What the paged, streamed session content is kept in. */
type SessionContentKey = "session" | "windowTurns" | "olderTurns" | "seamOpen"

/**
 * Everything but the open session's content: which session is open and how
 * the app around it is set up. It stays the same object while the session
 * streams, so what reads only this does not re-render on a live batch.
 */
export type SessionShellState = Omit<SessionState, SessionContentKey>

export type SessionAction =
  | { type: "LOAD_SESSION"; session: SessionView; source: SessionSource; isMobile: boolean }
  | { type: "GO_HOME"; isMobile: boolean }
  /** Leaves the open session only: a view it was open behind stays on screen. */
  | { type: "CLOSE_SESSION"; isMobile: boolean }
  | { type: "SWITCH_TEAM_MEMBER"; session: SessionView; source: SessionSource; memberName: string }
  | { type: "JUMP_TO_TURN"; index: number; toolCallId?: string }
  | { type: "SET_SEARCH_QUERY"; value: string }
  | { type: "SET_EXPAND_ALL"; value: boolean }
  | { type: "SET_EXPAND_TOOL_PAYLOADS"; value: boolean }
  | { type: "TOGGLE_EXPAND_ALL" }
  | { type: "SET_MOBILE_TAB"; tab: MobileTab }
  | { type: "UPDATE_SESSION"; session: SessionView }
  | { type: "SET_OLDER_TURNS"; turns: Turn[] }
  | { type: "RELOAD_SESSION_CONTENT"; session: SessionView; source: SessionSource }
  | { type: "SET_CURRENT_MEMBER_NAME"; name: string | null }
  | { type: "GUARD_MOBILE_TAB"; hasSession: boolean }
  | { type: "SET_LOADING_MEMBER"; name: string | null }
  | { type: "SET_DASHBOARD_PROJECT"; dirName: string | null }
  | { type: "INIT_PENDING_SESSION"; dirName: string; cwd?: string; isMobile: boolean }
  | { type: "FINALIZE_SESSION"; session: SessionView; source: SessionSource; isMobile: boolean }
  | { type: "OPEN_CONFIG"; filePath?: string }
  | { type: "CLOSE_CONFIG" }
  | { type: "OPEN_MISSION" }
  | { type: "CLOSE_MISSION" }
  | { type: "OPEN_EXTENSION_VIEW"; id: string }
  | { type: "CLOSE_EXTENSION_VIEW" }

const COLLAPSED_EXPANSION = {
  expandAll: false,
  expandToolPayloads: false,
} as const

const initialState: SessionState = {
  session: null,
  windowTurns: [],
  olderTurns: [],
  seamOpen: false,
  sessionSource: null,
  pendingDirName: null,
  pendingCwd: null,
  activeTurnIndex: null,
  activeToolCallId: null,
  searchQuery: "",
  ...COLLAPSED_EXPANSION,
  sessionChangeKey: 0,
  currentMemberName: null,
  loadingMember: null,
  mainView: "sessions",
  extensionViewId: null,
  configFilePath: null,
  mobileTab: "sessions",
  dashboardProject: null,
}

/** A peer message nothing answered yet, or a question still waiting for its reply. */
function leavesSomethingOpen(turns: readonly Turn[]): boolean {
  return turns.some((turn) => turn.contentBlocks.some((block) => block.kind === "agent_message" && !block.reply)
    || turn.toolCalls.some((call) => call.asyncQuestion === true && call.asyncAnswer === undefined))
}

/**
 * Rebuilds the rendered session from the live window plus the history paged in
 * above it. `prependTurns` dedupes by id, re-stitches the turn a page boundary
 * cut in half and re-pairs replies across the join, so replaying it is safe.
 */
function composeSession(
  session: SessionView,
  windowTurns: Turn[],
  olderTurns: Turn[],
  agentKind?: AgentKind,
): Pick<SessionState, "session" | "seamOpen"> {
  if (olderTurns.length === 0) return { session, seamOpen: false }
  const turns = prependTurns(windowTurns, olderTurns, agentKind)
  const offset = turns.length - windowTurns.length
  const seamOpen = offset < 0
    || windowTurns.some((turn, index) => index > 0 && turns[offset + index] !== turn)
    || leavesSomethingOpen(turns.slice(0, Math.max(0, offset) + 1))
  return { session: turns === session.turns ? session : { ...session, turns }, seamOpen }
}

/**
 * The live pipeline re-emits its window on every streamed batch, keeping each
 * turn that did not change. When the paged history is not affected, only the
 * window turns from the first changed one on are replaced, instead of merging
 * every page again.
 */
function updateSession(state: SessionState, session: SessionView): Pick<SessionState, "session" | "windowTurns" | "seamOpen"> {
  const windowTurns = session.turns
  const previous = state.windowTurns
  if (state.olderTurns.length > 0 && !state.seamOpen && state.session && windowTurns[0] === previous[0]) {
    let from = 1
    while (from < previous.length && from < windowTurns.length && windowTurns[from] === previous[from]) from++
    const offset = state.session.turns.length - previous.length
    const turns = state.session.turns.slice(0, offset + from).concat(windowTurns.slice(from))
    return { windowTurns, session: { ...session, turns }, seamOpen: false }
  }
  return { windowTurns, ...composeSession(session, windowTurns, state.olderTurns, state.sessionSource?.agentKind) }
}

/** Opening a different session discards the paging state of the previous one. */
function openSession(session: SessionView | null) {
  return { session, windowTurns: session?.turns ?? [], olderTurns: [], seamOpen: false }
}

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "LOAD_SESSION":
    case "FINALIZE_SESSION":
    case "INIT_PENDING_SESSION": {
      const pending = action.type === "INIT_PENDING_SESSION"
      return {
        ...state,
        ...openSession(pending ? null : action.session),
        sessionSource: pending ? null : action.source,
        pendingDirName: pending ? action.dirName : null,
        pendingCwd: pending ? action.cwd ?? null : null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        ...COLLAPSED_EXPANSION,

        mainView: "sessions",
        currentMemberName: null,
        dashboardProject: null,
        sessionChangeKey: state.sessionChangeKey + 1,
        mobileTab: action.isMobile ? "chat" : state.mobileTab,
      }
    }

    case "GO_HOME":
    case "CLOSE_SESSION": {
      const home = action.type === "GO_HOME"
      return {
        ...state,
        ...openSession(null),
        sessionSource: null,
        pendingDirName: null,
        pendingCwd: null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        ...COLLAPSED_EXPANSION,

        mainView: home ? "sessions" : state.mainView,
        currentMemberName: null,
        dashboardProject: null,
        mobileTab: action.isMobile && (home || state.mobileTab === "chat") ? "sessions" : state.mobileTab,
      }
    }

    case "SWITCH_TEAM_MEMBER":
      return {
        ...state,
        ...openSession(action.session),
        sessionSource: action.source,
        activeTurnIndex: null,
        searchQuery: "",
        ...COLLAPSED_EXPANSION,
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
      if (action.value) {
        if (state.expandAll && !state.expandToolPayloads) return state
        return { ...state, expandAll: true, expandToolPayloads: false }
      }
      if (!state.expandAll && !state.expandToolPayloads) return state
      return { ...state, ...COLLAPSED_EXPANSION }

    case "SET_EXPAND_TOOL_PAYLOADS":
      if (action.value) {
        if (state.expandAll && state.expandToolPayloads) return state
        return { ...state, expandAll: true, expandToolPayloads: true }
      }
      if (!state.expandToolPayloads) return state
      return { ...state, expandToolPayloads: false }

    case "TOGGLE_EXPAND_ALL":
      return state.expandAll
        ? { ...state, ...COLLAPSED_EXPANSION }
        : { ...state, expandAll: true }

    case "SET_MOBILE_TAB":
      if (state.mobileTab === action.tab) return state
      return { ...state, mobileTab: action.tab }

    case "UPDATE_SESSION":
      return { ...state, ...updateSession(state, action.session) }

    case "SET_OLDER_TURNS": {
      if (!state.session || action.turns === state.olderTurns) return state
      return {
        ...state,
        olderTurns: action.turns,
        ...composeSession(
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
      if (!action.hasSession && tab === "chat") {
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

    case "OPEN_CONFIG":
      return { ...state, mainView: "config", configFilePath: action.filePath ?? null }

    case "CLOSE_CONFIG":
      return { ...state, mainView: "sessions", configFilePath: null }

    case "OPEN_MISSION":
      return { ...state, mainView: "mission" }

    case "CLOSE_MISSION":
      return { ...state, mainView: "sessions" }

    case "OPEN_EXTENSION_VIEW":
      return { ...state, mainView: "extension", extensionViewId: action.id }

    case "CLOSE_EXTENSION_VIEW":
      return { ...state, mainView: "sessions", extensionViewId: null }

    default:
      return state
  }
}

export type SessionStore = Store<SessionState, SessionAction>

function selectShell({ session: _session, windowTurns: _window, olderTurns: _older, seamOpen: _seam, ...shell }: SessionState): SessionShellState {
  return shell
}

/**
 * The session state of one shell. The open session's content stays in
 * `store`: components select what they show from it, so a streamed batch
 * re-renders only those, never everything below the caller.
 */
/** A store holding `session`, open with nothing paged in; empty by default. */
export function createSessionStore(session: SessionView | null = null): SessionStore {
  return createStore(sessionReducer, { ...initialState, ...openSession(session) })
}

export function useSessionState(): readonly [SessionShellState, SessionStore["dispatch"], SessionStore] {
  const [store] = useState(() => createSessionStore())
  const state = useStoreSelector(store, selectShell, shallowEqual)
  return [state, store.dispatch, store]
}

/** A value derived from the open session; re-renders only when it changes by `isEqual`. */
export function useSessionSelector<T>(
  store: SessionStore,
  select: (session: SessionView | null) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useStoreSelector(store, (state: SessionState) => select(state.session), isEqual)
}
