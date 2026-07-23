import { type RefObject, memo, useRef, useEffect, useCallback } from "react"
import {
  Search,
  ArrowDown,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConversationTimeline } from "@/components/ConversationTimeline"
import { StickyPromptBanner } from "@/components/StickyPromptBanner"
import { PendingTurnPreview } from "@/components/PendingTurnPreview"
import { AgentStatusIndicator } from "@/components/timeline/AgentStatusIndicator"
import { StreamingTurnOverlay } from "@/components/timeline/StreamingTurnOverlay"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { FindInSession, type FindInSessionHandle } from "@/components/FindInSession"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { cn } from "@/lib/utils"

interface ChatAreaProps {
  searchInputRef: RefObject<HTMLInputElement | null>
  hasTodos?: boolean
  hasMore?: boolean
  isLoadingOlder?: boolean
  onLoadMore?: () => void
  mobileSearchOpen?: boolean
  onMobileSearchClose?: () => void
}

export const ChatArea = memo(function ChatArea({
  searchInputRef,
  hasTodos,
  hasMore,
  isLoadingOlder,
  onLoadMore,
  mobileSearchOpen = false,
  onMobileSearchClose,
}: ChatAreaProps) {
  const { state, dispatch, isMobile } = useAppContext()
  const { session } = useSessionContext()
  const { chat, scroll } = useSessionChatContext()

  const { searchQuery } = state
  const { pendingMessages } = chat
  const { chatScrollRef, scrollEndRef, handleScroll, canScrollDown, scrollToBottomInstant, initialScrollDone } = scroll
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

  useEffect(() => {
    if (!isMobile || !mobileSearchOpen) return
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [isMobile, mobileSearchOpen, searchInputRef])

  const closeMobileSearch = useCallback(() => {
    dispatch({ type: "SET_SEARCH_QUERY", value: "" })
    onMobileSearchClose?.()
  }, [dispatch, onMobileSearchClose])

  // session is guaranteed non-null when ChatArea renders
  const currentSession = session!
  const showTimeline = currentSession.turns.length > 0 || pendingMessages.length === 0

  return (
    <div className={cn("relative", isMobile ? "flex flex-col flex-1 min-h-0" : "flex-1 min-h-0")}>
      {/* Mobile search is intentionally on-demand so it does not consume a row. */}
      {isMobile && mobileSearchOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/40 bg-elevation-1 px-2 py-1">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => dispatch({ type: "SET_SEARCH_QUERY", value: e.target.value })}
              placeholder="Search conversation..."
              aria-label="Search conversation"
              className="h-10 border-border/50 bg-elevation-1 pl-8 text-xs placeholder:text-muted-foreground"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            onClick={closeMobileSearch}
            aria-label="Close conversation search"
          >
            <X />
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
          <div className={isMobile ? "px-2 py-2 pb-4" : cn("mx-auto max-w-3xl pt-4", hasTodos ? "pb-48" : "pb-32")}>
            <ErrorBoundary fallbackMessage="Failed to render conversation timeline">
              {showTimeline && (
                <ConversationTimeline
                  chatScrollRef={chatScrollRef}
                  hasMore={hasMore}
                  isLoadingOlder={isLoadingOlder}
                  pagingEnabled={initialScrollDone}
                  onLoadMore={onLoadMore}
                />
              )}
              <StreamingTurnOverlay />
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

        {/* Scroll-to-bottom FAB */}
        <button
          type="button"
          className={cn(
            "z-40 flex size-9 items-center justify-center rounded-full",
            "bg-blue-600 text-white border border-blue-500/50 depth-high",
            "transition-[opacity,transform] duration-200 ease-out active:scale-90",
            canScrollDown ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none",
            isMobile ? "absolute right-3 bottom-3" : "absolute right-4 bottom-4",
          )}
          onClick={scrollToBottomInstant}
          aria-label="Scroll to bottom"
        >
          <ArrowDown className="size-4" />
        </button>
      </div>
    </div>
  )
})
