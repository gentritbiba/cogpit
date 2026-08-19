import { useMemo, memo, type RefObject } from "react"
import { VirtualizedTimeline } from "./timeline/VirtualizedTimeline"
import { matchesSearch } from "@/lib/timelineHelpers"
import { shouldShowEmptyState } from "@/lib/timelinePaging"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { SessionImageGalleryProvider } from "./timeline/SessionImageGallery"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { MessageSquareText, SearchX } from "lucide-react"

// ── Main component ───────────────────────────────────────────────────────────

interface ConversationTimelineProps {
  chatScrollRef: RefObject<HTMLDivElement | null>
  hasMore?: boolean
  isLoadingOlder?: boolean
  pagingEnabled?: boolean
  onLoadMore?: () => void
}

export const ConversationTimeline = memo(function ConversationTimeline({
  chatScrollRef,
  hasMore,
  isLoadingOlder,
  pagingEnabled,
  onLoadMore,
}: ConversationTimelineProps) {
  const { state: { searchQuery, sessionChangeKey } } = useAppContext()
  const { session } = useSessionContext()

  const turns = session?.turns
  const allTurns = useMemo(
    () => turns ? turns.map((turn, index) => ({ turn, index })) : [],
    [turns]
  )
  const filteredTurns = useMemo(
    () => searchQuery
      ? allTurns.filter(({ turn }) => matchesSearch(turn, searchQuery))
      : allTurns,
    [allTurns, searchQuery]
  )

  // A search that matches nothing is not a dead end: App hydrates the rest of
  // the transcript in the background while a query is active.
  const showEmptyState = searchQuery
    ? filteredTurns.length === 0
    : shouldShowEmptyState(filteredTurns.length, hasMore ?? false)

  return (
    <SessionImageGalleryProvider>
      {showEmptyState ? (
        <Empty className="min-h-64 border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {searchQuery ? <SearchX /> : <MessageSquareText />}
            </EmptyMedia>
            <EmptyTitle>{searchQuery ? "No matching turns" : "No conversation yet"}</EmptyTitle>
            <EmptyDescription>
              {searchQuery
                ? "Try a different search term."
                : "Messages and tool activity will appear here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <VirtualizedTimeline
          // Remount per session so the height cache and prepend detection
          // never leak across different transcripts.
          key={sessionChangeKey}
          filteredTurns={filteredTurns}
          scrollContainerRef={chatScrollRef}
          hasMore={hasMore}
          isLoadingOlder={isLoadingOlder}
          pagingEnabled={pagingEnabled}
          onLoadMore={onLoadMore}
        />
      )}
    </SessionImageGalleryProvider>
  )
})
