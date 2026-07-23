import { useMemo, memo, type RefObject } from "react"
import { VirtualizedTimeline } from "./timeline/VirtualizedTimeline"
import { matchesSearch } from "@/lib/timelineHelpers"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { SessionImageGalleryProvider } from "./timeline/SessionImageGallery"

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

  return (
    <SessionImageGalleryProvider>
      {filteredTurns.length === 0 ? (
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
          {searchQuery ? "No turns match your search." : "No turns in this session."}
        </div>
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
