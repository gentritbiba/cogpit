import { useState, useCallback, useEffect, useMemo } from "react"
import { ChevronLeft, ChevronRight, RotateCcw, GitFork } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import type { Branch, Turn, ArchivedTurn } from "@/lib/types"
import { parseSession } from "@/lib/parser"
import { MiniBranchGraph } from "./MiniBranchGraph"
import { FullTurnCard, ArchivedTurnCard } from "./TurnCards"

// Re-export extracted modules so external imports remain unchanged
export { MiniBranchGraph } from "./MiniBranchGraph"
export { FullTurnCard, ArchivedTurnCard } from "./TurnCards"
export { BRANCH_COLORS, BRANCH_INNER, TOOL_BADGE_STYLES, toolSummary } from "./branchStyles"

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
  branches: Branch[]
  branchPointTurnIndex: number
  currentTurns: Turn[]
  onClose: () => void
  onRedoToTurn: (branchId: string, archiveTurnIndex: number) => void
  onRedoEntireBranch: (branchId: string) => void
}

export function BranchModal({
  branches,
  branchPointTurnIndex,
  currentTurns,
  onClose,
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[80vh] elevation-4 border-border/30 flex flex-col !top-[10%] !translate-y-0">
        <DialogHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <GitFork className="size-4 text-purple-400" />
              Branches from Turn {branchPointTurnIndex + 1}
            </DialogTitle>
          </div>

          {/* Branch navigation */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={goPrev}
              disabled={totalCount <= 1}
              aria-label="Previous branch"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="flex-1 text-center">
              <div className="text-sm font-medium text-foreground truncate">
                {current.label}
                {isCurrent && (
                  <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0 h-4 border-green-700/50 text-green-400">
                    active
                  </Badge>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground">
                Branch {currentIndex + 1} of {totalCount}
                {!isCurrent && (
                  <> &middot; {new Date(current.createdAt).toLocaleString()}</>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={goNext}
              disabled={totalCount <= 1}
              aria-label="Next branch"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        <Separator className="bg-border" />

        {/* Branch graph -- at the top */}
        <div className="shrink-0">
          <MiniBranchGraph
            branches={displayBranches}
            activeBranchIdx={currentIndex}
            branchPointTurnIndex={branchPointTurnIndex}
          />
        </div>

        <Separator className="bg-border" />

        {/* Branch turns -- full content, scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-3 py-3 px-1">
          {current.fullTurns
            ? current.fullTurns.map((turn, i) => (
                <FullTurnCard
                  key={i}
                  turn={turn}
                  archiveIndex={i}
                  branchId={current.id}
                  onRedoToHere={isCurrent ? undefined : onRedoToTurn}
                />
              ))
            : current.archivedTurns?.map((turn, i) => (
                <ArchivedTurnCard
                  key={i}
                  turn={turn}
                  archiveIndex={i}
                  branchId={current.id}
                  onRedoToHere={onRedoToTurn}
                />
              ))
          }
        </div>

        <Separator className="bg-border" />

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between py-2">
          <span className="text-xs text-muted-foreground">
            {turnCount} turn{turnCount !== 1 ? "s" : ""} in this branch
          </span>
          {!isCurrent && (
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-500 text-white gap-1.5"
              onClick={() => onRedoEntireBranch(current.id)}
            >
              <RotateCcw className="size-3.5 scale-x-[-1]" />
              Redo entire branch
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
