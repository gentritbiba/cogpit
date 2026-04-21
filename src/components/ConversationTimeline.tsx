import { useMemo, memo, type RefObject } from "react"
import { VirtualizedTimeline, NonVirtualTimeline } from "./timeline/VirtualizedTimeline"
import { PartialAssistantBlock } from "./timeline/PartialAssistantBlock"
import { matchesSearch } from "@/lib/timelineHelpers"
import { synthesizePartialTurns } from "@/lib/partialMessages"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"

// Threshold: only virtualize when we have enough turns to benefit
const VIRTUALIZE_THRESHOLD = 15

// ── Main component ───────────────────────────────────────────────────────────

interface ConversationTimelineProps {
  chatScrollRef: RefObject<HTMLDivElement | null>
  hasMore?: boolean
  onLoadMore?: () => void
}

export const ConversationTimeline = memo(function ConversationTimeline({
  chatScrollRef,
  hasMore,
  onLoadMore,
}: ConversationTimelineProps) {
  const { state: { searchQuery } } = useAppContext()
  const { session, partialMessages } = useSessionContext()

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

  // In-flight partial assistant messages — render as synthetic blocks below
  // the last canonical turn. When the canonical assistant message lands in
  // JSONL, `useLiveSession` drops the partial and the real `TurnSection`
  // takes its place with no flicker.
  //
  // `rawMessages` is the correct source for existing assistant ids because
  // `Turn.contentBlocks` doesn't carry the Anthropic message id — only the
  // raw JSONL entries do. We skip the scan entirely when there are no
  // partials, so cost is zero in the common case (feature flag off, or no
  // turn in flight).
  const partialTurns = useMemo(() => {
    if (!partialMessages || partialMessages.size === 0) return []
    const existingIds = new Set<string>()
    if (session) {
      for (const raw of session.rawMessages) {
        if (raw.type === "assistant") {
          const msg = (raw as { message?: { id?: string } }).message
          if (msg?.id) existingIds.add(msg.id)
        }
      }
    }
    return synthesizePartialTurns(partialMessages, existingIds)
  }, [partialMessages, session])

  const shouldVirtualize = filteredTurns.length >= VIRTUALIZE_THRESHOLD && chatScrollRef?.current != null

  if (filteredTurns.length === 0 && partialTurns.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        {searchQuery ? "No turns match your search." : "No turns in this session."}
      </div>
    )
  }

  const partialsNode = partialTurns.length > 0 ? (
    <div className="space-y-3">
      {partialTurns.map((p) => (
        <PartialAssistantBlock key={p.messageId} partial={p} />
      ))}
    </div>
  ) : null

  if (shouldVirtualize) {
    return (
      <>
        <VirtualizedTimeline
          filteredTurns={filteredTurns}
          scrollContainerRef={chatScrollRef}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
        />
        {partialsNode}
      </>
    )
  }

  return (
    <>
      <NonVirtualTimeline filteredTurns={filteredTurns} />
      {partialsNode}
    </>
  )
})
