import { type ReactNode, type RefObject, memo, useRef, useEffect, useCallback, useMemo } from "react"
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
import { AllowanceRecovery } from "@/components/AllowanceRecovery"
import { QueuedTurns } from "@/components/QueuedTurns"
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

/** Per-session state of the timeline's rows mounts here (rows' TimelineRowsProvider). */
function TimelineRowsScope({ children }: { sessionKey: string; children: ReactNode }) {
  return children
}

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
  const { session, sessionSource, rateLimit, permissions, isSubAgentView } = useSessionContext()
  const canUseTerminal = useCapability("terminal")
  const { chat, scroll } = useSessionChatContext()

  const { searchQuery } = state
  const { pendingMessages } = chat
  const { controller, chatScrollRef, canScrollDown, scrollToBottomInstant } = scroll
  const findRef = useRef<FindInSessionHandle>(null)
  const timelineRef = useMemo(() => ({ current: controller }), [controller])

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
  const rateLimitBanner = sessionSource
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
        <AllowanceRecovery
          className={cn("shrink-0", !isMobile && "pt-10")}
          {...rateLimitBanner}
          sessionId={currentSession.sessionId}
          canResume={permissions.send && !isSubAgentView}
          cwd={currentSession.cwd}
          terminal={canUseTerminal && permissions.send}
        />
      )}

      {/* Scrollable chat area */}
      <TimelineRowsScope sessionKey={currentSession.sessionId}>
      <div className="relative min-h-0 flex-1">
        <FindInSession ref={findRef} scrollContainerRef={chatScrollRef} />
        <StickyPromptBanner
          session={currentSession}
          scrollContainerRef={chatScrollRef}
          timelineRef={timelineRef}
        />
        <div
          ref={controller.setScroller}
          className={cn("h-full overflow-x-hidden overflow-y-auto [overflow-anchor:none]", isMobile ? "mobile-scroll" : rateLimit ? "scroll-pt-4" : "scroll-pt-14")}
        >
          <div
            className={isMobile ? "px-3 pt-3" : cn("mx-auto w-full max-w-[var(--chat-width)] px-6", rateLimit ? "pt-4" : "pt-14")}
          >
            <ErrorBoundary fallbackMessage="Failed to render conversation timeline">
              {showTimeline && (
                <ConversationTimeline
                  controller={controller}
                  hasMore={hasMore}
                  isLoadingOlder={isLoadingOlder}
                  onLoadMore={onLoadMore}
                />
              )}
              <div
                ref={controller.observeFooter}
                className={isMobile ? "pb-5" : undefined}
                style={isMobile ? undefined : { paddingBottom: `max(var(--session-footer-height, 0px), ${hasTodos ? 12 : 8}rem)` }}
              >
                <StreamingTurnOverlay />
                <AgentStatusIndicator />
                <QueuedTurns
                  sessionId={currentSession.sessionId}
                  turns={currentSession.turns}
                  pendingMessages={pendingMessages}
                  canManage={permissions.send && !isSubAgentView}
                  isMobile={isMobile}
                />
              </div>
            </ErrorBoundary>
          </div>
          <div ref={controller.setBottomSlack} aria-hidden />
        </div>

        {/* Scroll-to-bottom FAB */}
        <Button
          size="icon"
          className={cn(
            "absolute rounded-full shadow-sm transition-[opacity,transform] duration-200 ease-out active:scale-95",
            canScrollDown ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none",
            isMobile ? "right-3 bottom-3" : "right-5",
          )}
          style={isMobile ? undefined : { bottom: "calc(var(--session-footer-height, 0px) + 1.25rem)" }}
          onClick={scrollToBottomInstant}
          aria-label="Scroll to bottom"
        >
          <ArrowDown data-icon="inline-start" />
        </Button>
      </div>
      </TimelineRowsScope>
    </div>
  )
})
