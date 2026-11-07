import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { TimelineHandle } from "@/lib/timelineScroll/types"
import { turnKeysOf } from "@/lib/timelineScroll/turnKeys"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { Loader2, Redo2 } from "lucide-react"
import { UndoRedoBar } from "@/components/UndoRedoBar"
import { TurnSection } from "./TurnSection"
import { CompactionMarker } from "./CompactionMarker"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { isNearTop, isPrepend, type TimelineSnapshot } from "@/lib/timelinePaging"
import type { Turn } from "../../../shared/session/types"
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
  timelineRef?: React.Ref<TimelineHandle>
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
                turnKey={`ghost-${turn.id}`}
                isLast={false}
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

/** A turn the compaction opened and nothing has been added to yet. */
function isCompactionOnlyTurn(turn: Turn): boolean {
  return (turn.compactionSummary != null || turn.compactionMeta != null)
    && turn.userMessage == null
    && turn.contentBlocks.length === 0
}

// ── Interim TimelineHandle over virtua (the engine replaces this file) ───────

function interimHandle(
  scrollRef: React.RefObject<HTMLElement | null>,
  virtualizer: React.RefObject<VirtualizerHandle | null>,
  rows: { key: string }[],
): TimelineHandle {
  const top = (el: HTMLElement) => el.getBoundingClientRect().top + (parseFloat(getComputedStyle(el).scrollPaddingTop) || 0)
  return {
    scrollToTurn(turnKey, opts) {
      const index = rows.findIndex((row) => row.key === turnKey)
      const el = scrollRef.current
      if (index < 0 || !el || !virtualizer.current) return Promise.resolve(false)
      virtualizer.current.scrollToIndex(index, { align: "start" })
      return new Promise((resolve) => {
        let frames = 30
        let last: number | undefined
        const land = () => {
          const row = el.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(turnKey)}"]`)
          const target = (row && opts?.target?.(row)) ?? row
          if (target instanceof HTMLElement) {
            const rect = target.getBoundingClientRect()
            const offset = opts?.align === "center" ? (el.clientHeight - rect.height) / 2 : 0
            const want = Math.max(0, el.scrollTop + rect.top - top(el) - offset)
            if (last !== undefined && Math.abs(want - last) < 1) {
              el.scrollTo({ top: want })
              resolve(true)
              return
            }
            last = want
          }
          if (frames-- > 0) requestAnimationFrame(land)
          else resolve(false)
        }
        requestAnimationFrame(land)
      })
    },
    scrollToBottom() {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    },
    subscribe(listener) {
      const el = scrollRef.current
      if (!el) return () => {}
      let frame: number | null = null
      const schedule = () => { if (frame === null) frame = requestAnimationFrame(() => { frame = null; listener() }) }
      el.addEventListener("scroll", schedule, { passive: true })
      const observer = new ResizeObserver(schedule)
      if (el.firstElementChild) observer.observe(el.firstElementChild)
      return () => {
        el.removeEventListener("scroll", schedule)
        observer.disconnect()
        if (frame !== null) cancelAnimationFrame(frame)
      }
    },
    getViewport() {
      const el = scrollRef.current
      if (!el) return { firstVisibleKey: null, atBottom: true }
      const viewTop = top(el)
      let firstVisibleKey: string | null = null
      for (const row of el.querySelectorAll<HTMLElement>("[data-turn-key]")) {
        if (row.getBoundingClientRect().bottom > viewTop) {
          firstVisibleKey = row.dataset.turnKey ?? null
          break
        }
      }
      return { firstVisibleKey, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 4 }
    },
  }
}

// ── Virtualized timeline ─────────────────────────────────────────────────────

export function VirtualizedTimeline({
  filteredTurns,
  scrollContainerRef,
  hasMore = false,
  isLoadingOlder = false,
  pagingEnabled = false,
  onLoadMore,
  timelineRef,
}: VirtualizedTimelineProps) {
  const { state: { activeTurnIndex } } = useAppContext()
  const { undoRedo, session } = useSessionContext()
  const sessionTurns = session?.turns
  const allKeys = useMemo(() => turnKeysOf(sessionTurns ?? []), [sessionTurns])
  const lastIndex = (sessionTurns?.length ?? 0) - 1
  const handleRef = useRef<VirtualizerHandle>(null)
  const listWrapRef = useRef<HTMLDivElement>(null)
  const [startMargin, setStartMargin] = useState(0)

  // React keys must be stable across prepends, so key by turn id alone
  // (indices shift). Duplicate ids within one parse are disambiguated.
  const keyedTurns = useMemo(
    () => filteredTurns.map((entry) => ({ ...entry, key: allKeys[entry.index] ?? entry.turn.id })),
    [filteredTurns, allKeys],
  )

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
  useImperativeHandle(timelineRef, () => interimHandle(scrollContainerRef, handleRef, keyedTurns), [scrollContainerRef, keyedTurns])
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
      <div ref={listWrapRef} className="motion-session-enter">
        <Virtualizer
          ref={handleRef}
          scrollRef={scrollContainerRef}
          startMargin={startMargin}
          shift={shift}
        >
          {keyedTurns.map(({ turn, index, key }) => (
            <div key={key} data-turn-index={index}>
              {(turn.compactionSummary || turn.compactionMeta) && (
                <CompactionMarker summary={turn.compactionSummary} meta={turn.compactionMeta} disclosureKey={`${key}:compaction`} />
              )}
              {/* A compaction opens a turn of its own; suppress the empty
                  turn chrome until the conversation resumes into it. */}
              {!isCompactionOnlyTurn(turn) && (
                <TurnSection
                  turn={turn}
                  index={index}
                  turnKey={key}
                  isLast={index === lastIndex}
                  branchCount={undoRedo.branchesAtTurn ? undoRedo.branchesAtTurn(index).length : 0}
                />
              )}
            </div>
          ))}
        </Virtualizer>
      </div>
      <RedoSection />
    </>
  )
}
