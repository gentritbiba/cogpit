import { useState, useCallback, useEffect, useMemo } from "react"
import { ChevronLeft, ChevronRight, RotateCcw, GitFork } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import type { Branch, Turn, ArchivedTurn } from "../../../shared/session/types"
import { parseSession } from "../../../shared/session/parser"
import { MiniBranchGraph } from "./MiniBranchGraph"
import { FullTurnCard, ArchivedTurnCard } from "./TurnCards"

// ─── Entry for the unified branch list (current + archived) ──

export interface DisplayBranch {
  kind: "current" | "archived"
  id: string
  label: string
  createdAt: string
  /** Full parsed turns (from session or JSONL) */
  fullTurns: Turn[] | null
  /** Fallback archived turns */
  archivedTurns: ArchivedTurn[] | null
  /** Turn count for graph */
  graphTurnCount: number
  /** Original Branch ref (null for the current branch) */
  branch: Branch | null
}

interface BranchModalProps {
  open?: boolean
  branches: Branch[]
  branchPointTurnIndex: number
  currentTurns: Turn[]
  onClose: () => void
  onCloseComplete?: () => void
  onRedoToTurn: (branchId: string, archiveTurnIndex: number) => void
  onRedoEntireBranch: (branchId: string) => void
}

export function BranchModal({
  open = true,
  branches,
  branchPointTurnIndex,
  currentTurns,
  onClose,
  onCloseComplete,
  onRedoToTurn,
  onRedoEntireBranch,
}: BranchModalProps) {
  // Build unified list: current branch (1) + archived branches (2, 3, ...)
  const displayBranches = useMemo<DisplayBranch[]>(() => {
    const list: DisplayBranch[] = []

    // Branch 1 = current/main branch (turns from branch point onward)
    list.push({
      kind: "current",
      id: "__current__",
      label: "Current branch",
      createdAt: new Date().toISOString(),
      fullTurns: currentTurns,
      archivedTurns: null,
      graphTurnCount: currentTurns.length,
      branch: null,
    })

    // Branch 2+ = archived branches
    for (const branch of branches) {
      let fullTurns: Turn[] | null = null
      if (branch.jsonlLines.length > 0) {
        try {
          fullTurns = parseSession(branch.jsonlLines.join("\n")).turns
        } catch {
          // fallback to archived turns
        }
      }
      list.push({
        kind: "archived",
        id: branch.id,
        label: branch.label,
        createdAt: branch.createdAt,
        fullTurns,
        archivedTurns: fullTurns ? null : branch.turns,
        graphTurnCount: fullTurns ? fullTurns.length : branch.turns.length,
        branch,
      })
    }

    return list
  }, [branches, currentTurns])

  const [currentIndex, setCurrentIndex] = useState(0)
  const totalCount = displayBranches.length

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : totalCount - 1))
  }, [totalCount])

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i < totalCount - 1 ? i + 1 : 0))
  }, [totalCount])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev()
      else if (e.key === "ArrowRight") goNext()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [goPrev, goNext])

  const current = displayBranches[currentIndex]
  if (!current) return null

  const turnCount = current.fullTurns?.length ?? current.archivedTurns?.length ?? 0
  const isCurrent = current.kind === "current"

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) onCloseComplete?.() }}
    >
      <DialogContent className="flex max-h-[80dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 p-5 pb-4 pr-14">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="flex items-center gap-2">
              <GitFork className="size-4" />
              Branches from Turn {branchPointTurnIndex + 1}
            </DialogTitle>
          </div>
          <DialogDescription>
            Compare alternate continuations and resume from an earlier point.
          </DialogDescription>

          <div className="flex items-center gap-3 pt-3">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={goPrev}
              disabled={totalCount <= 1}
              aria-label="Previous branch"
            >
              <ChevronLeft data-icon="inline-start" />
            </Button>
            <div className="flex-1 text-center">
              <div className="truncate text-sm font-medium">
                {current.label}
                {isCurrent && (
                  <Badge variant="secondary" className="ml-2">
                    Active
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Branch {currentIndex + 1} of {totalCount}
                {!isCurrent && (
                  <> &middot; {new Date(current.createdAt).toLocaleString()}</>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={goNext}
              disabled={totalCount <= 1}
              aria-label="Next branch"
            >
              <ChevronRight data-icon="inline-start" />
            </Button>
          </div>
        </DialogHeader>

        <Separator />

        <div className="shrink-0 px-5 py-4">
          <MiniBranchGraph
            branches={displayBranches}
            activeBranchIdx={currentIndex}
            branchPointTurnIndex={branchPointTurnIndex}
          />
        </div>

        <Separator />

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-4">
            {turnCount === 0 ? (
              <Empty className="min-h-40">
                <EmptyHeader>
                  <EmptyTitle>No turns in this branch</EmptyTitle>
                  <EmptyDescription>This continuation has no saved turns.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : current.fullTurns
              ? current.fullTurns.map((turn, i) => (
                  <FullTurnCard
                  key={turn.id}
                    turn={turn}
                    archiveIndex={i}
                    branchId={current.id}
                    onRedoToHere={isCurrent ? undefined : onRedoToTurn}
                  />
                ))
              : current.archivedTurns?.map((turn, i) => (
                  <ArchivedTurnCard
                  key={turn.index}
                    turn={turn}
                    archiveIndex={i}
                    branchId={current.id}
                    onRedoToHere={onRedoToTurn}
                  />
                ))
            }
          </div>
        </ScrollArea>

        <Separator />

        <div className="flex shrink-0 items-center justify-between p-4">
          <span className="text-xs text-muted-foreground">
            {turnCount} turn{turnCount !== 1 ? "s" : ""} in this branch
          </span>
          {!isCurrent && (
            <Button
              size="sm"
              onClick={() => onRedoEntireBranch(current.id)}
            >
              <RotateCcw data-icon="inline-start" className="scale-x-[-1]" />
              Redo entire branch
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
