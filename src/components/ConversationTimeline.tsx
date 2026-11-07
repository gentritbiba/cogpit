import { useMemo, memo } from "react"
import { TimelineList } from "./timeline/TimelineList"
import { matchesSearch } from "@/lib/timelineHelpers"
import { shouldShowEmptyState } from "@/lib/timelinePaging"
import { turnKeysOf } from "@/lib/timelineScroll/turnKeys"
import type { TimelineScrollController } from "@/lib/timelineScroll/controller"
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
  controller: TimelineScrollController
  hasMore?: boolean
  isLoadingOlder?: boolean
  onLoadMore?: () => void
}

export const ConversationTimeline = memo(function ConversationTimeline({
  controller,
  hasMore = false,
  isLoadingOlder = false,
  onLoadMore,
}: ConversationTimelineProps) {
  const { state: { searchQuery, sessionChangeKey } } = useAppContext()
  const { session } = useSessionContext()

  const turns = session?.turns
  const allTurns = useMemo(() => {
    if (!turns) return []
    const keys = turnKeysOf(turns)
    return turns.map((turn, index) => ({ turn, index, key: keys[index] }))
  }, [turns])
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
    : shouldShowEmptyState(filteredTurns.length, hasMore)

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
        <TimelineList
          // A fresh list per session load, so nothing it remembers leaks across transcripts.
          key={sessionChangeKey}
          rows={filteredTurns}
          turnCount={turns?.length ?? 0}
          controller={controller}
          sessionKey={session?.sessionId ?? ""}
          sessionChangeKey={sessionChangeKey}
          hasMore={hasMore}
          isLoadingOlder={isLoadingOlder}
          onLoadMore={onLoadMore}
        />
      )}
    </SessionImageGalleryProvider>
  )
})
