import { type RefObject, memo, useRef, useEffect, useCallback } from "react"
import {
  Search,
  ArrowDown,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ConversationTimeline } from "@/components/ConversationTimeline"
import { StickyPromptBanner } from "@/components/StickyPromptBanner"
import { RateLimitBanner } from "@/components/RateLimitBanner"
import { PendingTurnPreview } from "@/components/PendingTurnPreview"
import { AgentStatusIndicator } from "@/components/timeline/AgentStatusIndicator"
import { StreamingTurnOverlay } from "@/components/timeline/StreamingTurnOverlay"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { FindInSession, type FindInSessionHandle } from "@/components/FindInSession"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { useCapability } from "@/hooks/useCapability"
import { matchesKeybinding } from "@/lib/keybindings"
import { cn } from "@/lib/utils"

/** Opens find-in-conversation from outside the timeline (the command palette). */
export const FIND_IN_CONVERSATION_EVENT = "cogpit:find-in-conversation"

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
  const { session, sessionSource, rateLimit, permissions } = useSessionContext()
  const canUseTerminal = useCapability("terminal")
  const { chat, scroll } = useSessionChatContext()

  const { searchQuery } = state
  const { pendingMessages } = chat
  const { chatScrollRef, scrollEndRef, handleScroll, canScrollDown, scrollToBottomInstant, initialScrollDone } = scroll
  const findRef = useRef<FindInSessionHandle>(null)

  // Cmd/Ctrl+F (or the command palette) → open find-in-session
  const handleFindOpen = useCallback(() => findRef.current?.open(), [])
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!matchesKeybinding("findInConversation", e)) return
      e.preventDefault()
      handleFindOpen()
    }
    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener(FIND_IN_CONVERSATION_EVENT, handleFindOpen)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener(FIND_IN_CONVERSATION_EVENT, handleFindOpen)
    }
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
  const rateLimitBanner = rateLimit && sessionSource
    ? { block: rateLimit, dirName: sessionSource.dirName, fileName: sessionSource.fileName }
    : null
  const showTimeline = currentSession.turns.length > 0 || pendingMessages.length === 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Mobile search is intentionally on-demand so it does not consume a row. */}
      {isMobile && mobileSearchOpen && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2">
          <InputGroup className="h-9 flex-1">
            <InputGroupInput
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => dispatch({ type: "SET_SEARCH_QUERY", value: e.target.value })}
              placeholder="Search conversation..."
              aria-label="Search conversation"
            />
            <InputGroupAddon align="inline-start">
              <Search />
            </InputGroupAddon>
          </InputGroup>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={closeMobileSearch}
            aria-label="Close conversation search"
          >
            <X data-icon="inline-start" />
          </Button>
        </div>
      )}

      {/* The desktop session chrome floats over the top of this column, so the
          banner clears it the same way the team bar does. */}
      {rateLimitBanner && (
        <div className={cn("shrink-0", !isMobile && "pt-10")}>
          <RateLimitBanner
            {...rateLimitBanner}
            cwd={currentSession.cwd}
            terminal={canUseTerminal && permissions.send}
          />
        </div>
      )}

      {/* Scrollable chat area */}
      <div className="relative min-h-0 flex-1">
        <FindInSession ref={findRef} scrollContainerRef={chatScrollRef} />
        <StickyPromptBanner
          session={currentSession}
          scrollContainerRef={chatScrollRef}
        />
        <div
          ref={chatScrollRef}
          onScroll={handleScroll}
          className={cn("h-full overflow-x-hidden overflow-y-auto", isMobile && "mobile-scroll")}
        >
          <div className={isMobile ? "px-3 py-3 pb-5" : cn("mx-auto w-full max-w-[var(--chat-width)] px-6", rateLimitBanner ? "pt-4" : "pt-14", hasTodos ? "pb-48" : "pb-32")}>
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
        <Button
          size="icon"
          className={cn(
            "absolute rounded-full shadow-sm transition-[opacity,transform] duration-200 ease-out active:scale-95",
            canScrollDown ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none",
            isMobile ? "right-3 bottom-3" : "right-5 bottom-5",
          )}
          onClick={scrollToBottomInstant}
          aria-label="Scroll to bottom"
        >
          <ArrowDown data-icon="inline-start" />
        </Button>
      </div>
    </div>
  )
})
