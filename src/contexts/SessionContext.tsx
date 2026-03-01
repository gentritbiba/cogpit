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
  pendingMessages: string[]
  isConnected: boolean
  sendMessage: (
    text: string,
    images?: Array<{ data: string; mediaType: string }>
  ) => void
  interrupt: () => void
  stopAgent: () => void
  consumePending: (count?: number) => void
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

// ── Session Context (stable — session data, undo/redo, actions) ─────────────

export interface SessionContextValue {
  /** The parsed session data (null when no session is loaded) */
  session: ParsedSession | null
  /** Source metadata for the loaded session */
  sessionSource: SessionSource | null
  /** Whether the session is actively streaming */
  isLive: boolean
  /** SSE connection state */
  sseState: SseConnectionState
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
    handleExpandCommand: (commandName: string, args?: string) => Promise<string | null>
    handleOpenBranches: (turnIndex: number) => void
    handleBranchFromHere: (turnIndex: number) => void
    handleToggleExpandAll: () => void
  }
}

const SessionContext = createContext<SessionContextValue | null>(null)

// ── Session Chat Context (volatile — chat status, scroll indicators) ────────

export interface SessionChatContextValue {
  chat: ChatState
  scroll: ScrollState
}

const SessionChatContext = createContext<SessionChatContextValue | null>(null)

// ── Providers ────────────────────────────────────────────────────────────────

interface SessionProviderProps {
  value: SessionContextValue
  chatValue: SessionChatContextValue
  children: ReactNode
}

export function SessionProvider({ value, chatValue, children }: SessionProviderProps): ReactNode {
  return (
    <SessionContext.Provider value={value}>
      <SessionChatContext.Provider value={chatValue}>
        {children}
      </SessionChatContext.Provider>
    </SessionContext.Provider>
  )
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) {
    throw new Error("useSessionContext must be used within a SessionProvider")
  }
  return ctx
}

export function useSessionChatContext(): SessionChatContextValue {
  const ctx = useContext(SessionChatContext)
  if (!ctx) {
    throw new Error("useSessionChatContext must be used within a SessionProvider")
  }
  return ctx
}
