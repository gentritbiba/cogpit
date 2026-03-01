import { useMemo, memo, type RefObject } from "react"
import { VirtualizedTimeline, NonVirtualTimeline } from "./timeline/VirtualizedTimeline"
import { matchesSearch } from "@/lib/timelineHelpers"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"

// Threshold: only virtualize when we have enough turns to benefit
const VIRTUALIZE_THRESHOLD = 15

// ── Main component ───────────────────────────────────────────────────────────

interface ConversationTimelineProps {
  chatScrollRef: RefObject<HTMLDivElement | null>
}

export const ConversationTimeline = memo(function ConversationTimeline({
  chatScrollRef,
}: ConversationTimelineProps) {
  const { state: { searchQuery } } = useAppContext()
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

  const shouldVirtualize = filteredTurns.length >= VIRTUALIZE_THRESHOLD && chatScrollRef?.current != null

  if (filteredTurns.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        {searchQuery ? "No turns match your search." : "No turns in this session."}
      </div>
    )
  }

  if (shouldVirtualize) {
    return <VirtualizedTimeline filteredTurns={filteredTurns} scrollContainerRef={chatScrollRef} />
  }

  return <NonVirtualTimeline filteredTurns={filteredTurns} />
})
