import { useMemo, memo } from "react"
import { VirtualizedTimeline, NonVirtualTimeline } from "./timeline/VirtualizedTimeline"
import type { TimelineInnerProps } from "./timeline/VirtualizedTimeline"
import { matchesSearch } from "@/lib/timelineHelpers"
import type { ParsedSession, Turn, Branch } from "@/lib/types"

// Re-export sub-components for external consumers
export { TurnSection } from "./timeline/TurnSection"
export type { TurnSectionProps } from "./timeline/TurnSection"
export { CompactionMarker } from "./timeline/CompactionMarker"
export { VirtualizedTimeline, NonVirtualTimeline } from "./timeline/VirtualizedTimeline"
export type { TimelineInnerProps } from "./timeline/VirtualizedTimeline"
export { matchesSearch, collectToolCalls, toolCallCountLabel } from "@/lib/timelineHelpers"

// ── Types ────────────────────────────────────────────────────────────────────

interface ConversationTimelineProps {
  session: ParsedSession
  activeTurnIndex: number | null
  activeToolCallId: string | null
  searchQuery: string
  expandAll: boolean
  isAgentActive?: boolean
  isSubAgentView?: boolean
  scrollContainerRef?: React.RefObject<HTMLElement | null>
  branchesAtTurn?: (turnIndex: number) => Branch[]
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
  onBranchFromHere?: (turnIndex: number) => void
  canRedo?: boolean
  redoTurnCount?: number
  redoGhostTurns?: Turn[]
  onRedoAll?: () => void
  onRedoUpTo?: (ghostTurnIndex: number) => void
  onEditCommand?: (commandName: string) => void
}

// Threshold: only virtualize when we have enough turns to benefit
const VIRTUALIZE_THRESHOLD = 30

// ── Main component ───────────────────────────────────────────────────────────

export const ConversationTimeline = memo(function ConversationTimeline({
  session,
  activeTurnIndex,
  activeToolCallId,
  searchQuery,
  expandAll,
  isAgentActive = false,
  isSubAgentView = false,
  scrollContainerRef,
  branchesAtTurn,
  onRestoreToHere,
  onOpenBranches,
  onBranchFromHere,
  canRedo = false,
  redoTurnCount = 0,
  redoGhostTurns = [],
  onRedoAll,
  onRedoUpTo,
  onEditCommand,
}: ConversationTimelineProps) {
  const hasUndoCallbacks = onRestoreToHere !== undefined

  const allTurns = useMemo(
    () => session.turns.map((turn, index) => ({ turn, index })),
    [session.turns]
  )
  const filteredTurns = useMemo(
    () => searchQuery
      ? allTurns.filter(({ turn }) => matchesSearch(turn, searchQuery))
      : allTurns,
    [allTurns, searchQuery]
  )

  const shouldVirtualize = filteredTurns.length >= VIRTUALIZE_THRESHOLD && scrollContainerRef?.current != null

  if (filteredTurns.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        {searchQuery ? "No turns match your search." : "No turns in this session."}
      </div>
    )
  }

  const sharedProps: TimelineInnerProps = {
    filteredTurns,
    activeTurnIndex,
    activeToolCallId,
    expandAll,
    isAgentActive,
    isSubAgentView,
    hasUndoCallbacks,
    branchesAtTurn,
    onRestoreToHere,
    onOpenBranches,
    onBranchFromHere,
    canRedo,
    redoTurnCount,
    redoGhostTurns,
    onRedoAll,
    onRedoUpTo,
    sessionTurnCount: session.turns.length,
    onEditCommand,
  }

  if (shouldVirtualize) {
    return <VirtualizedTimeline {...sharedProps} scrollContainerRef={scrollContainerRef} />
  }

  return <NonVirtualTimeline {...sharedProps} />
})
