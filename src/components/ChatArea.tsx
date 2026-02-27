import { type RefObject, memo } from "react"
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
import { useElapsedTimer } from "@/hooks/useElapsedTimer"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { cn } from "@/lib/utils"

interface ChatAreaProps {
  searchInputRef: RefObject<HTMLInputElement | null>
}

export const ChatArea = memo(function ChatArea({
  searchInputRef,
}: ChatAreaProps) {
  const { state, dispatch, isMobile } = useAppContext()
  const { session, chat, scroll, actions } = useSessionContext()

  const { searchQuery, expandAll } = state
  const { pendingMessage, isConnected } = chat
  const { chatScrollRef, scrollEndRef, canScrollUp, canScrollDown, handleScroll } = scroll

  const elapsedSec = useElapsedTimer(isConnected)

  // session is guaranteed non-null when ChatArea renders
  const currentSession = session!
  const showTimeline = currentSession.turns.length > 0 || !pendingMessage

  return (
    <div className={cn("relative", isMobile ? "flex flex-col flex-1 min-h-0" : "h-full")}>
      {/* Search bar (mobile only - desktop has it in StatsPanel) */}
      {isMobile && (
        <div className="flex items-center gap-1.5 shrink-0 border-b border-border/50 bg-elevation-1 px-2 py-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => dispatch({ type: "SET_SEARCH_QUERY", value: e.target.value })}
              placeholder="Search conversation..."
              className="h-8 bg-elevation-1 pl-8 text-sm border-border/50 placeholder:text-muted-foreground focus-visible:ring-blue-500/30"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 shrink-0"
            onClick={actions.handleToggleExpandAll}
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
          session={currentSession}
          scrollContainerRef={chatScrollRef}
        />
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-elevation-0 to-transparent transition-opacity duration-200",
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
              {showTimeline && (
                <ConversationTimeline />
              )}
              {pendingMessage && (
                <PendingTurnPreview
                  message={pendingMessage}
                  turnNumber={currentSession.turns.length + 1}
                  elapsedSec={isConnected ? elapsedSec : undefined}
                />
              )}
              <div ref={scrollEndRef} />
            </ErrorBoundary>
          </div>
        </div>
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-elevation-0 to-transparent transition-opacity duration-200",
            canScrollDown ? "opacity-100" : "opacity-0"
          )}
        />
      </div>
    </div>
  )
})
