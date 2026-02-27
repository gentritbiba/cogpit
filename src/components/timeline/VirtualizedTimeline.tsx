import { useEffect, useRef, useCallback, useMemo } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Redo2 } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { TurnContextMenu } from "@/components/TurnContextMenu"
import { UndoRedoBar } from "@/components/UndoRedoBar"
import { TurnSection } from "./TurnSection"
import { CompactionMarker } from "./CompactionMarker"
import type { Turn, Branch } from "@/lib/types"

// ── Types ────────────────────────────────────────────────────────────────────

export interface TimelineInnerProps {
  filteredTurns: { turn: Turn; index: number }[]
  activeTurnIndex: number | null
  activeToolCallId: string | null
  expandAll: boolean
  isAgentActive: boolean
  isSubAgentView: boolean
  hasUndoCallbacks: boolean
  branchesAtTurn?: (turnIndex: number) => Branch[]
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
  onBranchFromHere?: (turnIndex: number) => void
  canRedo: boolean
  redoTurnCount: number
  redoGhostTurns: Turn[]
  onRedoAll?: () => void
  onRedoUpTo?: (ghostTurnIndex: number) => void
  sessionTurnCount: number
  onEditCommand?: (commandName: string) => void
  onExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
}

// ── Context menu wrapper ─────────────────────────────────────────────────────

/** Conditionally wraps children in a TurnContextMenu when undo callbacks are available. */
function MaybeContextMenuTurn({
  turn,
  index,
  props,
  children,
}: {
  turn: Turn
  index: number
  props: TimelineInnerProps
  children: React.ReactNode
}) {
  const { hasUndoCallbacks, branchesAtTurn, onRestoreToHere, onOpenBranches, onBranchFromHere } = props

  if (!hasUndoCallbacks || !onRestoreToHere || !onOpenBranches) {
    return <>{children}</>
  }

  const turnBranches = branchesAtTurn ? branchesAtTurn(index) : []

  return (
    <TurnContextMenu
      turnIndex={index}
      branches={turnBranches}
      onRestoreToHere={onRestoreToHere}
      onOpenBranches={onOpenBranches}
      onBranchFromHere={onBranchFromHere}
    >
      {children}
    </TurnContextMenu>
  )
}

// ── Redo section ─────────────────────────────────────────────────────────────

function RedoSection({
  canRedo,
  redoTurnCount,
  redoGhostTurns,
  onRedoAll,
  onRedoUpTo,
  sessionTurnCount,
}: {
  canRedo: boolean
  redoTurnCount: number
  redoGhostTurns: Turn[]
  onRedoAll?: () => void
  onRedoUpTo?: (ghostTurnIndex: number) => void
  sessionTurnCount: number
}) {
  if (!canRedo || !onRedoAll) return null
  return (
    <>
      <UndoRedoBar
        redoTurnCount={redoTurnCount}
        onRedoAll={onRedoAll}
      />
      {redoGhostTurns.length > 0 && (
        <div className="select-none">
          {redoGhostTurns.map((turn, i) => (
            <div key={`ghost-${turn.id}`} className="group/ghost relative opacity-25 hover:opacity-40 transition-opacity">
              <TurnSection
                turn={turn}
                index={sessionTurnCount + i}
                isActive={false}
                activeToolCallId={null}
                expandAll={false}
              />
              {onRedoUpTo && (
                <button
                  onClick={() => onRedoUpTo(i)}
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

export function NonVirtualTimeline(props: TimelineInnerProps) {
  const {
    filteredTurns,
    activeTurnIndex,
    canRedo,
    redoTurnCount,
    redoGhostTurns,
    onRedoAll,
    onRedoUpTo,
    sessionTurnCount,
  } = props

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
        <MaybeContextMenuTurn key={turn.id} turn={turn} index={index} props={props}>
          <div ref={setTurnRef(index)} data-turn-index={index}>
            {turn.compactionSummary && (
              <CompactionMarker summary={turn.compactionSummary} />
            )}
            <TurnSection
              turn={turn}
              index={index}
              isActive={activeTurnIndex === index}
              activeToolCallId={props.activeToolCallId}
              expandAll={props.expandAll}
              isAgentActive={props.isAgentActive && index === sessionTurnCount - 1}
              isSubAgentView={props.isSubAgentView}
              branchCount={props.branchesAtTurn ? props.branchesAtTurn(index).length : 0}
              onRestoreToHere={props.onRestoreToHere}
              onOpenBranches={props.onOpenBranches}
              onEditCommand={props.onEditCommand}
              onExpandCommand={props.onExpandCommand}
            />
          </div>
        </MaybeContextMenuTurn>
      ))}
      <RedoSection
        canRedo={canRedo}
        redoTurnCount={redoTurnCount}
        redoGhostTurns={redoGhostTurns}
        onRedoAll={onRedoAll}
        onRedoUpTo={onRedoUpTo}
        sessionTurnCount={sessionTurnCount}
      />
    </div>
  )
}

// ── Virtualized timeline ─────────────────────────────────────────────────────

export function VirtualizedTimeline(
  props: TimelineInnerProps & { scrollContainerRef: React.RefObject<HTMLElement | null> }
) {
  const {
    filteredTurns,
    scrollContainerRef,
    activeTurnIndex,
    canRedo,
    redoTurnCount,
    redoGhostTurns,
    onRedoAll,
    onRedoUpTo,
    sessionTurnCount,
  } = props

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
          <MaybeContextMenuTurn key={turn.id} turn={turn} index={index} props={props}>
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
                isActive={activeTurnIndex === index}
                activeToolCallId={props.activeToolCallId}
                expandAll={props.expandAll}
                isAgentActive={props.isAgentActive && index === sessionTurnCount - 1}
                isSubAgentView={props.isSubAgentView}
                branchCount={props.branchesAtTurn ? props.branchesAtTurn(index).length : 0}
                onRestoreToHere={props.onRestoreToHere}
                onOpenBranches={props.onOpenBranches}
                onEditCommand={props.onEditCommand}
                onExpandCommand={props.onExpandCommand}
              />
              {!isLastVirtualRow && <Separator className="bg-border/60" />}
            </div>
          </MaybeContextMenuTurn>
        )
      })}
      <div style={{ position: "absolute", top: `${virtualizer.getTotalSize()}px`, width: "100%" }}>
        <RedoSection
          canRedo={canRedo}
          redoTurnCount={redoTurnCount}
          redoGhostTurns={redoGhostTurns}
          onRedoAll={onRedoAll}
          onRedoUpTo={onRedoUpTo}
          sessionTurnCount={sessionTurnCount}
        />
      </div>
    </div>
  )
}
