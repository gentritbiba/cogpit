import { useEffect, useRef, useCallback, useMemo } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Redo2 } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { TurnContextMenu } from "@/components/TurnContextMenu"
import { UndoRedoBar } from "@/components/UndoRedoBar"
import { TurnSection } from "./TurnSection"
import { CompactionMarker } from "./CompactionMarker"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import type { Turn } from "@/lib/types"

// ── Types ────────────────────────────────────────────────────────────────────

interface TimelineInnerProps {
  filteredTurns: { turn: Turn; index: number }[]
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
  const { undoRedo, actions } = useSessionContext()
  const { requestUndo, branchesAtTurn } = undoRedo
  const { handleOpenBranches, handleBranchFromHere } = actions

  if (!requestUndo || !handleOpenBranches) {
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
  const { session, undoRedo } = useSessionContext()
  const { canRedo, redoTurnCount, redoGhostTurns, requestRedoAll, requestRedoUpTo } = undoRedo
  const sessionTurnCount = session?.turns.length ?? 0

  if (!canRedo || !requestRedoAll) return null
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
                <button
                  onClick={() => requestRedoUpTo(i)}
                  className="absolute top-4 right-4 opacity-0 group-hover/ghost:opacity-100 transition-opacity z-10 flex items-center gap-1 text-[10px] text-green-400 hover:text-green-300 bg-elevation-1 border border-border/50 rounded px-2 py-1"
                >
                  <Redo2 className="size-3" />
                  Redo to here
                </button>
              )}
              {i < redoGhostTurns.length - 1 && (
                <Separator className="bg-border/60" />
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ── Non-virtualized timeline ─────────────────────────────────────────────────

export function NonVirtualTimeline({ filteredTurns }: TimelineInnerProps) {
  const { state: { activeTurnIndex } } = useAppContext()
  const { undoRedo } = useSessionContext()

  const turnRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const setTurnRef = useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      if (el) {
        turnRefs.current.set(index, el)
      } else {
        turnRefs.current.delete(index)
      }
    },
    []
  )

  useEffect(() => {
    if (activeTurnIndex === null) return
    const el = turnRefs.current.get(activeTurnIndex)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [activeTurnIndex])

  return (
    <div className="space-y-3">
      {filteredTurns.map(({ turn, index }) => (
        <MaybeContextMenuTurn key={turn.id} index={index}>
          <div ref={setTurnRef(index)} data-turn-index={index}>
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
      ))}
      <RedoSection />
    </div>
  )
}

// ── Virtualized timeline ─────────────────────────────────────────────────────

export function VirtualizedTimeline({
  filteredTurns,
  scrollContainerRef,
}: TimelineInnerProps & { scrollContainerRef: React.RefObject<HTMLElement | null> }) {
  const { state: { activeTurnIndex } } = useAppContext()
  const { undoRedo } = useSessionContext()

  const virtualizer = useVirtualizer({
    count: filteredTurns.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 200,
    overscan: 5,
  })

  const turnIndexToVirtualIdx = useMemo(() => {
    const map = new Map<number, number>()
    for (let i = 0; i < filteredTurns.length; i++) {
      map.set(filteredTurns[i].index, i)
    }
    return map
  }, [filteredTurns])

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
      virtualizer.scrollToIndex(virtualIdx, { align: "start", behavior: "smooth" })
    }
  }, [activeTurnIndex, turnIndexToVirtualIdx, virtualizer])

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: "100%",
        position: "relative",
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const { turn, index } = filteredTurns[virtualRow.index]
        const isLastVirtualRow = virtualRow.index === filteredTurns.length - 1

        return (
          <MaybeContextMenuTurn key={turn.id} index={index}>
            <div
              data-index={virtualRow.index}
              data-turn-index={index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {turn.compactionSummary && (
                <CompactionMarker summary={turn.compactionSummary} />
              )}
              <TurnSection
                turn={turn}
                index={index}
                branchCount={undoRedo.branchesAtTurn ? undoRedo.branchesAtTurn(index).length : 0}
              />
              {!isLastVirtualRow && <Separator className="bg-border/60" />}
            </div>
          </MaybeContextMenuTurn>
        )
      })}
      <div style={{ position: "absolute", top: `${virtualizer.getTotalSize()}px`, width: "100%" }}>
        <RedoSection />
      </div>
    </div>
  )
}
