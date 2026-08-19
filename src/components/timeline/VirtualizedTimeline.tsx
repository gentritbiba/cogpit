import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { Loader2, Redo2 } from "lucide-react"
import { TurnContextMenu } from "@/components/TurnContextMenu"
import { UndoRedoBar } from "@/components/UndoRedoBar"
import { TurnSection } from "./TurnSection"
import { CompactionMarker } from "./CompactionMarker"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { isNearTop, isPrepend, type TimelineSnapshot } from "@/lib/timelinePaging"
import type { Turn } from "@/lib/types"
import { Button } from "@/components/ui/button"

// ── Types ────────────────────────────────────────────────────────────────────

interface VirtualizedTimelineProps {
  filteredTurns: { turn: Turn; index: number }[]
  scrollContainerRef: React.RefObject<HTMLElement | null>
  hasMore?: boolean
  isLoadingOlder?: boolean
  /** False until the initial bottom placement for this session has happened. */
  pagingEnabled?: boolean
  onLoadMore?: () => void
}

// ── Context menu wrapper ─────────────────────────────────────────────────────

/** Conditionally wraps children in a TurnContextMenu when undo callbacks are available. */
function MaybeContextMenuTurn({
  index,
  children,
}: {
  index: number
  children: React.ReactNode
}) {
  const { isSubAgentView, undoRedo, actions } = useSessionContext()
  const { requestUndo, branchesAtTurn } = undoRedo
  const { handleOpenBranches, handleBranchFromHere } = actions

  if (!undoRedo.enabled || isSubAgentView || !requestUndo || !handleOpenBranches) {
    return <>{children}</>
  }

  return (
    <TurnContextMenu
      turnIndex={index}
      branches={branchesAtTurn(index)}
      onRestoreToHere={requestUndo}
      onOpenBranches={handleOpenBranches}
      onBranchFromHere={handleBranchFromHere}
    >
      {children}
    </TurnContextMenu>
  )
}

// ── Redo section ─────────────────────────────────────────────────────────────

function RedoSection() {
  const { session, isSubAgentView, undoRedo } = useSessionContext()
  const { canRedo, redoTurnCount, redoGhostTurns, requestRedoAll, requestRedoUpTo } = undoRedo
  const sessionTurnCount = session?.turns.length ?? 0

  if (!undoRedo.enabled || isSubAgentView || !canRedo || !requestRedoAll) return null
  return (
    <>
      <UndoRedoBar
        redoTurnCount={redoTurnCount}
        onRedoAll={requestRedoAll}
      />
      {redoGhostTurns.length > 0 && (
        <div className="select-none">
          {redoGhostTurns.map((turn, i) => (
            <div key={`ghost-${turn.id}`} className="group/ghost relative opacity-25 hover:opacity-40 transition-opacity">
              <TurnSection
                turn={turn}
                index={sessionTurnCount + i}
              />
              {requestRedoUpTo && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => requestRedoUpTo(i)}
                  className="absolute right-4 top-4 text-success opacity-0 transition-opacity group-hover/ghost:opacity-100"
                >
                  <Redo2 data-icon="inline-start" />
                  Redo to here
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ── History status slot ──────────────────────────────────────────────────────

/**
 * Fixed-height slot above the list. Its height never changes while mounted so
 * paging state transitions can never shift the content below it.
 */
function HistoryStatusSlot({ hasMore, isLoadingOlder }: { hasMore: boolean; isLoadingOlder: boolean }) {
  return (
    <div className="flex h-8 select-none items-center justify-center text-xs text-muted-foreground" data-testid="history-status">
      {isLoadingOlder ? (
        <span className="flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" data-icon="inline-start" />
          Loading older turns…
        </span>
      ) : hasMore ? null : (
        <span>Beginning of session</span>
      )}
    </div>
  )
}

// ── Virtualized timeline ─────────────────────────────────────────────────────

export function VirtualizedTimeline({
  filteredTurns,
  scrollContainerRef,
  hasMore = false,
  isLoadingOlder = false,
  pagingEnabled = false,
  onLoadMore,
}: VirtualizedTimelineProps) {
  const { state: { activeTurnIndex } } = useAppContext()
  const { undoRedo } = useSessionContext()
  const handleRef = useRef<VirtualizerHandle>(null)
  const listWrapRef = useRef<HTMLDivElement>(null)
  const [startMargin, setStartMargin] = useState(0)

  // React keys must be stable across prepends, so key by turn id alone
  // (indices shift). Duplicate ids within one parse are disambiguated.
  const keyedTurns = useMemo(() => {
    const seen = new Map<string, number>()
    return filteredTurns.map((entry) => {
      const n = seen.get(entry.turn.id) ?? 0
      seen.set(entry.turn.id, n + 1)
      return { ...entry, key: n === 0 ? entry.turn.id : `${entry.turn.id}#${n}` }
    })
  }, [filteredTurns])

  // Prepend detection drives virtua's `shift` prop: during a prepend the
  // scroll position is maintained from the end, so older turns appear above
  // the viewport without moving what the user is reading.
  const prevSnapshotRef = useRef<TimelineSnapshot | null>(null)
  const shift = useMemo(
    () => isPrepend(prevSnapshotRef.current, keyedTurns.map((t) => t.key)),
    [keyedTurns],
  )
  useLayoutEffect(() => {
    prevSnapshotRef.current = { firstKey: keyedTurns[0]?.key, length: keyedTurns.length }
  }, [keyedTurns])

  // Once history paging has been observed, keep the status slot mounted so its
  // appearance/disappearance can never shift content.
  const showSlotRef = useRef(hasMore)
  useEffect(() => {
    if (hasMore) showSlotRef.current = true
  }, [hasMore])
  const showSlot = hasMore || showSlotRef.current

  // The virtualizer needs to know how much non-virtualized content sits above
  // it inside the scroll container (padding + status slot).
  useLayoutEffect(() => {
    const scrollEl = scrollContainerRef.current
    const listEl = listWrapRef.current
    if (!scrollEl || !listEl) return
    const margin =
      listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    setStartMargin((prev) => (Math.abs(prev - margin) < 1 ? prev : margin))
  }, [scrollContainerRef, showSlot])

  // Distance-based load trigger: fires when the viewport is within
  // NEAR_TOP_VIEWPORTS of the top, re-checks on scroll and after every
  // completed load, so short pages chain until the buffer above is filled.
  useEffect(() => {
    if (!hasMore || !onLoadMore || !pagingEnabled || isLoadingOlder) return
    const el = scrollContainerRef.current
    if (!el) return
    const check = () => {
      if (isNearTop(el.scrollTop, el.clientHeight)) onLoadMore()
    }
    check()
    el.addEventListener("scroll", check, { passive: true })
    return () => el.removeEventListener("scroll", check)
  }, [hasMore, isLoadingOlder, pagingEnabled, onLoadMore, keyedTurns.length, scrollContainerRef])

  // Jump to the turn selected in the stats/sidebar panels.
  const turnIndexToVirtualIdx = useMemo(() => {
    const map = new Map<number, number>()
    for (let i = 0; i < keyedTurns.length; i++) map.set(keyedTurns[i].index, i)
    return map
  }, [keyedTurns])
  const lastScrolledTurnRef = useRef<number | null>(null)
  useEffect(() => {
    if (activeTurnIndex === null) {
      lastScrolledTurnRef.current = null
      return
    }
    if (activeTurnIndex === lastScrolledTurnRef.current) return
    lastScrolledTurnRef.current = activeTurnIndex
    const virtualIdx = turnIndexToVirtualIdx.get(activeTurnIndex)
    if (virtualIdx !== undefined) {
      handleRef.current?.scrollToIndex(virtualIdx, { align: "start", smooth: true })
    }
  }, [activeTurnIndex, turnIndexToVirtualIdx])

  return (
    <>
      {showSlot && <HistoryStatusSlot hasMore={hasMore} isLoadingOlder={isLoadingOlder} />}
      <div ref={listWrapRef}>
        <Virtualizer
          ref={handleRef}
          scrollRef={scrollContainerRef}
          startMargin={startMargin}
          shift={shift}
        >
          {keyedTurns.map(({ turn, index, key }) => (
            <div key={key} data-turn-index={index}>
              <MaybeContextMenuTurn index={index}>
                <div>
                  {turn.compactionSummary && (
                    <CompactionMarker summary={turn.compactionSummary} />
                  )}
                  <TurnSection
                    turn={turn}
                    index={index}
                    branchCount={undoRedo.branchesAtTurn ? undoRedo.branchesAtTurn(index).length : 0}
                  />
                </div>
              </MaybeContextMenuTurn>
            </div>
          ))}
        </Virtualizer>
      </div>
      <RedoSection />
    </>
  )
}
