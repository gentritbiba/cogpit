import type { ComposerCreated } from "@/lib/composerDraftIdentity"
import { createContext, useContext, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref, type RefObject, type RefCallback, type ReactNode } from "react"
import { useChatScroll } from "@/hooks/useChatScroll"
import { createSessionStore, useSessionSelector, useShownSession, type SessionStore } from "@/hooks/useSessionState"
import { withStartPrompt } from "@/lib/startPrompts"
import type { SessionView } from "../../shared/session/sessionDigest"
import type { RateLimitBlock } from "../../shared/session/rateLimit"
import type { SseConnectionState } from "@/hooks/useLiveSession"
import type { SessionSource } from "@/lib/sessionSource"
import type { UseUndoRedoResult } from "@/hooks/useUndoRedo"
import type { PtyChatStatus } from "@/hooks/usePtyChat"
import type { PendingInteraction } from "../../shared/session/parser"
import type { SlashSuggestion } from "../../shared/contracts/projectTools"
import type { PermissionRequest, PermissionDecision } from "@/hooks/usePermissionRequests"
import type { SessionActionPermissions } from "@/lib/sessionAccessPermissions"
import type { ComposerAttachment, ComposerContextItem, QuoteSource } from "../../shared/session/composerContext"

// ── Chat (pty) ──────────────────────────────────────────────────────────────

export interface ChatState {
  status: PtyChatStatus
  error: string | undefined
  pendingMessages: string[]
  isConnected: boolean
  /** Resolves false when the message was not sent because the session may not be driven here. */
  sendMessage: (
    text: string,
    images?: Array<{ data: string; mediaType: string }>,
    onCreated?: ComposerCreated,
  ) => Promise<boolean>
  interrupt: () => void
  stopAgent: () => void
  consumePending: (count?: number) => void
}

// ── Scroll ──────────────────────────────────────────────────────────────────

export interface ScrollState {
  chatScrollRef: RefObject<HTMLDivElement | null>
  observeChatContent?: RefCallback<HTMLDivElement>
  canScrollDown: boolean
  initialScrollDone: boolean
  handleScroll: () => void
  scrollToBottomInstant: () => void
  requestScrollToTop: () => void
  resetTurnCount: (count: number) => void
}

// ── Session Context (the open session, undo/redo, actions) ─────────────────

export interface SessionContextValue {
  /** The parsed session data (null when no session is loaded) */
  session: SessionView | null
  /** Changes with every load of a session; it always belongs to `session`. */
  sessionChangeKey: number
  /** The turn in focus, counted in `session.turns`. */
  activeTurnIndex: number | null
  activeToolCallId: string | null
  /** Where the open session was loaded from; in the session context, where `session` was. */
  sessionSource: SessionSource | null
  /** Whether the session is actively streaming */
  isLive: boolean
  /** SSE connection state */
  sseState: SseConnectionState
  /** Whether the session is currently compacting (in progress) */
  isCompacting: boolean
  /** A turn that failed with no HTTP response waiting on it (null when none) */
  turnError: string | null
  /** Predicted next prompt from the last turn (null when the CLI sent none) */
  promptSuggestion: string | null
  /** The runtime refused the turn on a spent allowance (null while it is serving) */
  rateLimit: RateLimitBlock | null
  /** Undo/redo system */
  undoRedo: UseUndoRedoResult
  /** Pending interaction detected in the session */
  pendingInteraction: PendingInteraction | null
  /** Pending permission requests from the CLI */
  permissionRequests: PermissionRequest[]
  permissionResponding: Set<string>
  respondPermission: (requestId: string, behavior: PermissionDecision) => void
  respondAllPermissions: (behavior: PermissionDecision) => void
  /** Whether the current view is a sub-agent (read-only) */
  isSubAgentView: boolean
  /** What the signed-in user may do in this session; everything in personal edition. */
  permissions: SessionActionPermissions
  /** Slash command suggestions */
  slashSuggestions: SlashSuggestion[]
  slashSuggestionsLoading: boolean
  /** Session actions */
  actions: {
    handleStopSession: () => Promise<void>
    handleEditConfig?: (filePath: string) => void
    handleEditCommand?: (commandName: string) => void
    handleExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
    /** Turn indices from the provider's contexts count the turns on screen. */
    handleOpenBranches?: (turnIndex: number) => void
    handleBranchFromHere?: (turnIndex: number) => void
    handleToggleExpandAll: () => void
    /** Load a session (or sub-agent session) by dirName + fileName — matches the sidebar behavior. */
    handleLoadSession: (dirName: string, fileName: string) => void
    handleProviderHandoff?: () => void
    /** Add typed context to the open composer; returns why it could not be added, or null. */
    handleAddComposerContext?: (item: ComposerContextItem, attachments?: ComposerAttachment[]) => string | null
    /** Jump to a quoted reply's source; false when it can no longer be found. */
    handleOpenQuoteSource?: (source: QuoteSource, text: string) => Promise<boolean>
  }
}

const SessionContext = createContext<SessionContextValue | null>(null)

/** Everything in the session context but the session's content, which changes on every live batch. */
export type SessionControls = Omit<SessionContextValue, "session" | "sessionChangeKey" | "activeTurnIndex" | "activeToolCallId">

const SessionControlsContext = createContext<SessionControls | null>(null)
const SessionStoreContext = createContext<SessionStore | null>(null)
const NO_SESSION = createSessionStore()

// ── Session Chat Context (volatile — chat status, scroll indicators) ────────

export interface SessionChatContextValue {
  chat: ChatState
  scroll: ScrollState
}

const SessionChatContext = createContext<SessionChatContextValue | null>(null)

// ── Providers ────────────────────────────────────────────────────────────────

interface OpenSessionProviderProps {
  store: SessionStore
  controls: SessionControls
  chat: ChatState
  isLive: boolean
  /** The transcript's scroll controls, for the shell's own handlers. */
  scrollHandle?: Ref<ScrollState>
  /** Runs in the commit that first shows each session object. */
  onSessionShown?: (session: SessionView | null) => void
  children: ReactNode
}

/**
 * Where the turn at `index` of the session on screen sits in the store's
 * session, which can be ahead of it: a batch or page not shown yet, or
 * another session already open. Null when the store's session lacks it.
 */
function storeTurnIndex(shown: SessionView | null, open: SessionView | null, index: number): number | null {
  if (!shown || !open || shown.sessionId !== open.sessionId) return null
  const turn = shown.turns[index]
  if (!turn) return null
  // Batches add turns behind it and pages in front of it, so look there first.
  for (const at of [index, index + open.turns.length - shown.turns.length]) {
    if (open.turns[at]?.id === turn.id) return at
  }
  const at = open.turns.findIndex(({ id }) => id === turn.id)
  return at < 0 ? null : at
}

/** `controls` with the actions that take a turn index counting the turns on screen. */
function onScreenTurns(controls: SessionControls, toStore: (index: number) => number | null): SessionControls {
  const resolved = (act: (turnIndex: number) => void) => (index: number) => {
    const at = toStore(index)
    if (at !== null) act(at)
  }
  const { undoRedo, actions } = controls
  return {
    ...controls,
    undoRedo: { ...undoRedo, requestUndo: resolved(undoRedo.requestUndo) },
    actions: {
      ...actions,
      handleOpenBranches: actions.handleOpenBranches && resolved(actions.handleOpenBranches),
      handleBranchFromHere: actions.handleBranchFromHere && resolved(actions.handleBranchFromHere),
    },
  }
}

/**
 * Provides the session open in `store`, as `useShownSession` shows it. Only
 * this provider and the components that read the session's content re-render
 * on a live batch; whatever renders it, and what reads only the controls or a
 * selected fact, does not.
 */
export function OpenSessionProvider({
  store, controls, chat, isLive, scrollHandle, onSessionShown, children,
}: OpenSessionProviderProps): ReactNode {
  const { session, sessionChangeKey, sessionSource, activeTurnIndex, activeToolCallId } = useShownSession(store)
  const shown = useMemo(() => session && withStartPrompt(session), [session])
  const onScreenRef = useRef<SessionView | null>(null)
  useLayoutEffect(() => {
    onScreenRef.current = session
    onSessionShown?.(session)
  }, [session, onSessionShown])
  // A row acts after the commit that showed it, which the store may be ahead of.
  const screenControls = useMemo(
    () => onScreenTurns(controls, (index) => storeTurnIndex(onScreenRef.current, store.getState().session, index)),
    [controls, store],
  )
  const scroll = useChatScroll({
    session,
    isLive,
    pendingMessages: chat.pendingMessages,
    consumePending: chat.consumePending,
    sessionChangeKey,
  })
  useImperativeHandle(scrollHandle, () => scroll, [scroll])
  const value = useMemo(
    () => ({ ...screenControls, session: shown, sessionChangeKey, sessionSource, activeTurnIndex, activeToolCallId }),
    [screenControls, shown, sessionChangeKey, sessionSource, activeTurnIndex, activeToolCallId],
  )
  const chatValue = useMemo(() => ({ chat, scroll }), [chat, scroll])
  return (
    <SessionStoreContext.Provider value={store}>
      <SessionControlsContext.Provider value={screenControls}>
        <SessionContext.Provider value={value}>
          <SessionChatContext.Provider value={chatValue}>
            {children}
          </SessionChatContext.Provider>
        </SessionContext.Provider>
      </SessionControlsContext.Provider>
    </SessionStoreContext.Provider>
  )
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** The session, or null outside a session provider (shared views, previews). */
export function useSessionContextOptional(): SessionContextValue | null {
  return useContext(SessionContext)
}

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) {
    throw new Error("useSessionContext must be used within an OpenSessionProvider")
  }
  return ctx
}

/** The session context without the session, so a live batch does not re-render the caller. */
export function useSessionControls(): SessionControls {
  const ctx = useContext(SessionControlsContext)
  if (!ctx) {
    throw new Error("useSessionControls must be used within an OpenSessionProvider")
  }
  return ctx
}

/** The controls, or null outside a session provider (shared views, previews). */
export function useSessionControlsOptional(): SessionControls | null {
  return useContext(SessionControlsContext)
}

/**
 * A value derived from the open session (null when none is open, or outside a
 * provider). The caller re-renders only when it changes by `isEqual`.
 */
export function useOpenSession<T>(
  select: (session: SessionView | null) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useSessionSelector(useContext(SessionStoreContext) ?? NO_SESSION, select, isEqual)
}

/** The chat, or null outside a session provider (shared views, previews). */
export function useSessionChatContextOptional(): SessionChatContextValue | null {
  return useContext(SessionChatContext)
}

export function useSessionChatContext(): SessionChatContextValue {
  const ctx = useContext(SessionChatContext)
  if (!ctx) {
    throw new Error("useSessionChatContext must be used within an OpenSessionProvider")
  }
  return ctx
}
