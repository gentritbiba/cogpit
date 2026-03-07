import { type RefObject, memo, useRef, useEffect, useCallback } from "react"
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
import { AgentStatusIndicator } from "@/components/timeline/AgentStatusIndicator"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { FindInSession, type FindInSessionHandle } from "@/components/FindInSession"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { cn } from "@/lib/utils"

interface ChatAreaProps {
  searchInputRef: RefObject<HTMLInputElement | null>
  hasTodos?: boolean
}

export const ChatArea = memo(function ChatArea({
  searchInputRef,
  hasTodos,
}: ChatAreaProps) {
  const { state, dispatch, isMobile } = useAppContext()
  const { session, actions } = useSessionContext()
  const { chat, scroll } = useSessionChatContext()

  const { searchQuery, expandAll } = state
  const { pendingMessages } = chat
  const { chatScrollRef, scrollEndRef, handleScroll } = scroll
  const findRef = useRef<FindInSessionHandle>(null)

  // Cmd/Ctrl+F → open find-in-session
  const handleFindOpen = useCallback(() => findRef.current?.open(), [])
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "f" && !e.shiftKey) {
        e.preventDefault()
        handleFindOpen()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleFindOpen])

  // session is guaranteed non-null when ChatArea renders
  const currentSession = session!
  const showTimeline = currentSession.turns.length > 0 || pendingMessages.length === 0

  return (
    <div className={cn("relative", isMobile ? "flex flex-col flex-1 min-h-0" : "flex-1 min-h-0")}>
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
        <FindInSession ref={findRef} scrollContainerRef={chatScrollRef} />
        <StickyPromptBanner
          session={currentSession}
          scrollContainerRef={chatScrollRef}
        />
        <div
          ref={chatScrollRef}
          onScroll={handleScroll}
          className={cn("h-full overflow-y-auto overflow-x-hidden elevation-1", isMobile && "mobile-scroll")}
        >
          <div className={isMobile ? "py-3 px-1 pb-24" : cn("mx-auto max-w-3xl pt-4", hasTodos ? "pb-48" : "pb-32")}>
            <ErrorBoundary fallbackMessage="Failed to render conversation timeline">
              {showTimeline && (
                <ConversationTimeline chatScrollRef={chatScrollRef} />
              )}
              {pendingMessages.map((msg, i) => (
                <PendingTurnPreview
                  key={i}
                  message={msg}
                  turnNumber={currentSession.turns.length + 1 + i}
                />
              ))}
              <AgentStatusIndicator />
              <div ref={scrollEndRef} />
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  )
})
