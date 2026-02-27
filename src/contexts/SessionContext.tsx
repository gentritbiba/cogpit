import { createContext, useContext, type RefObject, type ReactNode } from "react"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource, SseConnectionState } from "@/hooks/useLiveSession"
import type { UseUndoRedoResult } from "@/hooks/useUndoRedo"
import type { PtyChatStatus } from "@/hooks/usePtyChat"
import type { PendingInteraction } from "@/lib/parser"
import type { SlashSuggestion } from "@/hooks/useSlashSuggestions"

// ── Chat (pty) ──────────────────────────────────────────────────────────────

export interface ChatState {
  status: PtyChatStatus
  error: string | undefined
  pendingMessage: string | null
  isConnected: boolean
  sendMessage: (
    text: string,
    images?: Array<{ data: string; mediaType: string }>
  ) => void
  interrupt: () => void
  stopAgent: () => void
  clearPending: () => void
}

// ── Scroll ──────────────────────────────────────────────────────────────────

export interface ScrollState {
  chatScrollRef: RefObject<HTMLDivElement | null>
  scrollEndRef: RefObject<HTMLDivElement | null>
  canScrollUp: boolean
  canScrollDown: boolean
  handleScroll: () => void
  scrollToBottomInstant: () => void
  requestScrollToTop: () => void
  resetTurnCount: (count: number) => void
}

// ── Combined Session Context ────────────────────────────────────────────────

export interface SessionContextValue {
  /** The parsed session data (null when no session is loaded) */
  session: ParsedSession | null
  /** Source metadata for the loaded session */
  sessionSource: SessionSource | null
  /** Whether the session is actively streaming */
  isLive: boolean
  /** SSE connection state */
  sseState: SseConnectionState
  /** Pty chat state and actions */
  chat: ChatState
  /** Scroll management for the chat area */
  scroll: ScrollState
  /** Undo/redo system */
  undoRedo: UseUndoRedoResult
  /** Pending interaction detected in the session */
  pendingInteraction: PendingInteraction | null
  /** Whether the current view is a sub-agent (read-only) */
  isSubAgentView: boolean
  /** Slash command suggestions */
  slashSuggestions: SlashSuggestion[]
  slashSuggestionsLoading: boolean
  /** Session actions */
  actions: {
    handleStopSession: () => Promise<void>
    handleEditConfig: (filePath: string) => void
    handleEditCommand: (commandName: string) => void
    handleOpenBranches: (turnIndex: number) => void
    handleBranchFromHere: (turnIndex: number) => void
    handleToggleExpandAll: () => void
  }
}

const SessionContext = createContext<SessionContextValue | null>(null)

// ── Provider ────────────────────────────────────────────────────────────────

interface SessionProviderProps {
  value: SessionContextValue
  children: ReactNode
}

export function SessionProvider({ value, children }: SessionProviderProps): ReactNode {
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  )
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) {
    throw new Error("useSessionContext must be used within a SessionProvider")
  }
  return ctx
}
