import { type RefObject, type Dispatch, useRef, useEffect, useState } from "react"
import {
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConversationTimeline } from "@/components/ConversationTimeline"
import { StickyPromptBanner } from "@/components/StickyPromptBanner"
import { PendingTurnPreview } from "@/components/PendingTurnPreview"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import type { ParsedSession } from "@/lib/types"
import type { SessionAction } from "@/hooks/useSessionState"
import type { useUndoRedo } from "@/hooks/useUndoRedo"
import { cn } from "@/lib/utils"

interface ChatAreaProps {
  session: ParsedSession
  activeTurnIndex: number | null
  activeToolCallId: string | null
  searchQuery: string
  expandAll: boolean
  isMobile: boolean
  dispatch: Dispatch<SessionAction>
  searchInputRef: RefObject<HTMLInputElement | null>
  // Scroll
  chatScrollRef: RefObject<HTMLDivElement | null>
  scrollEndRef: RefObject<HTMLDivElement | null>
  canScrollUp: boolean
  canScrollDown: boolean
  handleScroll: () => void
  // Undo/redo
  undoRedo: ReturnType<typeof useUndoRedo>
  onOpenBranches: (turnIndex: number) => void
  onBranchFromHere?: (turnIndex: number) => void
  // Pending message
  pendingMessage: string | null
  isConnected: boolean
  // Callbacks
  onToggleExpandAll: () => void
}

export function ChatArea({
  session,
  activeTurnIndex,
  activeToolCallId,
  searchQuery,
  expandAll,
  isMobile,
  dispatch,
  searchInputRef,
  chatScrollRef,
  scrollEndRef,
  canScrollUp,
  canScrollDown,
  handleScroll,
  undoRedo,
  onOpenBranches,
  onBranchFromHere,
  pendingMessage,
  isConnected,
  onToggleExpandAll,
}: ChatAreaProps) {
  const connectedAtRef = useRef<number | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)

  useEffect(() => {
    if (!isConnected) {
      connectedAtRef.current = null
      setElapsedSec(0)
      return
    }
    connectedAtRef.current = Date.now()
    setElapsedSec(0)
    const interval = setInterval(() => {
      if (connectedAtRef.current !== null) {
        setElapsedSec(Math.floor((Date.now() - connectedAtRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [isConnected])

  return (
    <div className={cn("relative", isMobile ? "flex flex-col flex-1 min-h-0" : "h-full")}>
      {/* Search bar (mobile only - desktop has it in StatsPanel) */}
      {isMobile && (
        <div className="flex items-center gap-1.5 shrink-0 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-sm px-2 py-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => dispatch({ type: "SET_SEARCH_QUERY", value: e.target.value })}
              placeholder="Search conversation..."
              className="h-8 bg-zinc-900/50 pl-8 text-sm border-zinc-700/50 placeholder:text-zinc-600 focus-visible:ring-blue-500/30"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 shrink-0"
            onClick={onToggleExpandAll}
            aria-label={expandAll ? "Collapse all" : "Expand all"}
          >
            {expandAll ? (
              <ChevronsDownUp className="size-4" />
            ) : (
              <ChevronsUpDown className="size-4" />
            )}
          </Button>
        </div>
      )}

      {/* Scrollable chat area */}
      <div className={cn("relative", isMobile ? "flex-1 min-h-0" : "h-full")}>
        <StickyPromptBanner
          session={session}
          scrollContainerRef={chatScrollRef}
        />
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-zinc-950 to-transparent transition-opacity duration-200",
            canScrollUp ? "opacity-100" : "opacity-0"
          )}
        />
        <div
          ref={chatScrollRef}
          onScroll={handleScroll}
          className={cn("h-full overflow-y-auto", isMobile && "mobile-scroll")}
        >
          <div className={isMobile ? "py-3 px-1" : "mx-auto max-w-4xl py-4"}>
            <ErrorBoundary fallbackMessage="Failed to render conversation timeline">
              {/* Hide the empty-state placeholder when a pending message is
                  waiting for the first turn to arrive (e.g. right after session
                  creation). The timeline renders normally once turns exist. */}
              {(session.turns.length > 0 || !pendingMessage) && (
                <ConversationTimeline
                  session={session}
                  activeTurnIndex={activeTurnIndex}
                  activeToolCallId={activeToolCallId}
                  searchQuery={searchQuery}
                  expandAll={expandAll}
                  isAgentActive={isConnected}
                  scrollContainerRef={chatScrollRef}
                  branchesAtTurn={undoRedo.branchesAtTurn}
                  onRestoreToHere={undoRedo.requestUndo}
                  onOpenBranches={onOpenBranches}
                  onBranchFromHere={onBranchFromHere}
                  canRedo={undoRedo.canRedo}
                  redoTurnCount={undoRedo.redoTurnCount}
                  redoGhostTurns={undoRedo.redoGhostTurns}
                  onRedoAll={undoRedo.requestRedoAll}
                  onRedoUpTo={undoRedo.requestRedoUpTo}
                />
              )}
              {pendingMessage && (
                <PendingTurnPreview
                  message={pendingMessage}
                  turnNumber={session.turns.length + 1}
                  elapsedSec={isConnected ? elapsedSec : undefined}
                />
              )}
              <div ref={scrollEndRef} />
            </ErrorBoundary>
          </div>
        </div>
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-zinc-950 to-transparent transition-opacity duration-200",
            canScrollDown ? "opacity-100" : "opacity-0"
          )}
        />
      </div>
    </div>
  )
}
