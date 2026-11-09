import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { Loader2, Redo2 } from "lucide-react"
import { UndoRedoBar } from "@/components/UndoRedoBar"
import { TurnSection } from "./TurnSection"
import { CompactionMarker } from "./CompactionMarker"
import { revealKey, revealToolCall, useTimelineStore } from "./disclosure"
import { BlockWindowHostContext } from "./WindowedItems"
import { toolSelector } from "@/lib/sessionFindDom"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import type { TimelineScrollController } from "@/lib/timelineScroll/controller"
import type { Turn } from "../../../shared/session/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface TimelineRowEntry {
  turn: Turn
  /** Index in the session's turns. */
  index: number
  key: string
}

interface TimelineListProps {
  rows: readonly TimelineRowEntry[]
  turnCount: number
  controller: TimelineScrollController
  sessionKey: string
  sessionChangeKey: number
  hasMore: boolean
  isLoadingOlder: boolean
  onLoadMore?: () => void
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

/** A turn the compaction opened and nothing has been added to yet. */
function isCompactionOnlyTurn(turn: Turn): boolean {
  return (turn.compactionSummary != null || turn.compactionMeta != null)
    && turn.userMessage == null
    && turn.contentBlocks.length === 0
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface TimelineRowProps {
  turn: Turn
  index: number
  rowKey: string
  isLast: boolean
  branchCount: number
  setSize: number
  rowRef: (el: HTMLElement | null) => () => void
}

const TimelineRow = memo(function TimelineRow({ turn, index, rowKey, isLast, branchCount, setSize, rowRef }: TimelineRowProps) {
  return (
    <div
      ref={rowRef}
      data-row-key={rowKey}
      data-turn-index={index}
      data-scroll-anchor=""
      role="article"
      aria-posinset={index + 1}
      aria-setsize={setSize}
      tabIndex={0}
    >
      {(turn.compactionSummary || turn.compactionMeta) && (
        <CompactionMarker summary={turn.compactionSummary} meta={turn.compactionMeta} disclosureKey={`${rowKey}:compaction`} />
      )}
      {/* A compaction opens a turn of its own; suppress the empty turn chrome
          until the conversation resumes into it. */}
      {!isCompactionOnlyTurn(turn) && (
        <TurnSection
          turn={turn}
          index={index}
          turnKey={rowKey}
          isLast={isLast}
          branchCount={branchCount}
        />
      )}
    </div>
  )
})

// ── List ─────────────────────────────────────────────────────────────────────

const HISTORY_STATUS = "flex h-8 select-none items-center justify-center text-xs text-muted-foreground"

/**
 * The rows the scroll engine has planned, between a top pad it sizes itself
 * (history not loaded yet, plus rows above the range) and a bottom pad.
 */
export function TimelineList({
  rows,
  turnCount,
  controller,
  sessionKey,
  sessionChangeKey,
  hasMore,
  isLoadingOlder,
  onLoadMore,
}: TimelineListProps) {
  const { state: { activeTurnIndex, activeToolCallId, expandAll } } = useAppContext()
  const store = useTimelineStore()
  const { undoRedo } = useSessionContext()
  const plan = useSyncExternalStore(controller.subscribePlan, controller.getPlan)
  const [, forceRender] = useReducer((count: number) => count + 1, 0)

  const keys = useMemo(() => rows.map((row) => row.key), [rows])
  const indexOf = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys])

  // Once older history has been paged, the start of the session gets a marker.
  const [paged, setPaged] = useState(hasMore)
  if (hasMore && !paged) setPaged(true)
  const showBeginning = !hasMore && paged

  useLayoutEffect(() => {
    controller.commit({ keys, sessionKey, sessionChangeKey, expandAll, hasMore, isLoadingOlder, onLoadMore })
    // The store subscription only starts after paint; catch a plan made before it.
    if (controller.getPlan() !== plan) forceRender()
  })

  // Jump to the turn (or one of its tool calls) selected in the stats and
  // sidebar panels. The selection is an index, so a prepend either leaves it
  // pointing at another turn or moves it with its turn; neither is a new
  // selection to jump to. Everything after resolving the key goes by key.
  const jumpedRef = useRef<{ index: number; key: string; callId: string | null } | null>(null)
  useEffect(() => {
    if (activeTurnIndex === null) {
      jumpedRef.current = null
      return
    }
    const target = rows.find((row) => row.index === activeTurnIndex)
    const jumped = jumpedRef.current
    if (jumped && jumped.callId === activeToolCallId && (activeTurnIndex === jumped.index || target?.key === jumped.key)) {
      jumped.index = activeTurnIndex
      return
    }
    if (!target) return
    jumpedRef.current = { index: activeTurnIndex, key: target.key, callId: activeToolCallId }
    if (!activeToolCallId) {
      void controller.scrollToTurn(target.key, { align: "start" })
      return
    }
    if (store) revealToolCall(store, target.key, target.turn, activeToolCallId)
    const selector = toolSelector(activeToolCallId)
    void controller.scrollToTurn(target.key, { align: "center", target: (row) => row.querySelector(selector) }).then(() => {
      if (store?.get(revealKey(target.key)) === activeToolCallId) store.set(revealKey(target.key), null)
    })
  }, [activeTurnIndex, activeToolCallId, rows, controller, store])

  const setSize = hasMore ? -1 : turnCount
  const children: ReactNode[] = []
  plan.segments.forEach((segment, i) => {
    const start = indexOf.get(segment.first)
    const last = indexOf.get(segment.last)
    if (start === undefined || last === undefined || last < start) return
    if (i > 0 && plan.gaps[i] > 0) {
      children.push(<div key={`gap:${segment.first}`} aria-hidden style={{ height: plan.gaps[i] }} />)
    }
    for (let r = start; r <= last; r++) {
      const { turn, index, key } = rows[r]
      children.push(
        <TimelineRow
          key={key}
          turn={turn}
          index={index}
          rowKey={key}
          isLast={index === turnCount - 1}
          branchCount={undoRedo.branchesAtTurn ? undoRedo.branchesAtTurn(index).length : 0}
          setSize={setSize}
          rowRef={controller.rowRef(key)}
        />,
      )
    }
  })

  return (
    <BlockWindowHostContext.Provider value={controller}>
      <div ref={controller.setList} role="feed" aria-busy={isLoadingOlder} className="motion-fade-enter">
        {showBeginning && (
          <div className={HISTORY_STATUS} data-testid="history-status">Beginning of session</div>
        )}
        <div ref={controller.setTopPad} aria-hidden className={cn("relative", hasMore && "timeline-reserve")}>
          {isLoadingOlder && (
            <div className={cn(HISTORY_STATUS, "absolute inset-x-0 bottom-0 gap-1.5")} data-testid="history-status">
              <Loader2 className="size-3 animate-spin" data-icon="inline-start" />
              Loading older turns…
            </div>
          )}
        </div>
        {children}
        <div aria-hidden style={{ height: plan.bottomPad }} />
      </div>
      <div ref={controller.observeFooter}>
        <RedoSection />
      </div>
    </BlockWindowHostContext.Provider>
  )
}
