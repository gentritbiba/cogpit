import { useState, useCallback, useEffect } from "react"
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
import type { Branch, ArchivedTurn } from "@/lib/types"
import { cn } from "@/lib/utils"

// ─── Branch Colors ────────────────────────────────────────────

const BRANCH_COLORS = ["#3b82f6", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899", "#22c55e"]
const BRANCH_INNER = ["#60a5fa", "#c084fc", "#fbbf24", "#22d3ee", "#f472b6", "#4ade80"]

// ─── Mini Branch Graph ────────────────────────────────────────

function MiniBranchGraph({
  branches,
  activeBranchIdx,
  branchPointTurnIndex,
}: {
  branches: Branch[]
  activeBranchIdx: number
  branchPointTurnIndex: number
}) {
  const numBranches = branches.length
  if (numBranches === 0) return null

  const sharedCount = Math.min(branchPointTurnIndex + 1, 5)
  const maxBranchTurns = Math.max(...branches.map((b) => b.turns.length), 1)
  const cappedMax = Math.min(maxBranchTurns, 6)

  const ss = 25 // shared node spacing
  const bpX = 20 + sharedCount * ss
  const ns = Math.min(32, Math.max(20, (300 - bpX) / (cappedMax + 1)))

  const branchGap = 27
  const firstY = 18
  const height = firstY + (numBranches - 1) * branchGap + 15

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
      <svg width="100%" height={height} viewBox={`0 0 340 ${height}`}>
        {/* Shared trunk */}
        <line x1={20} y1={firstY} x2={bpX} y2={firstY} stroke="#3b82f6" strokeWidth={2} />
        {Array.from({ length: sharedCount }).map((_, i) => (
          <g key={`s-${i}`}>
            <circle cx={20 + i * ss} cy={firstY} r={3.5} fill="#09090b" stroke="#3b82f6" strokeWidth={1.5} />
            <circle cx={20 + i * ss} cy={firstY} r={1.5} fill="#60a5fa" />
          </g>
        ))}
        {/* Branch point */}
        <circle cx={bpX} cy={firstY} r={5} fill="#09090b" stroke="#a855f7" strokeWidth={2} />
        <circle cx={bpX} cy={firstY} r={2} fill="#c084fc" />

        {/* Branches */}
        {branches.map((branch, bi) => {
          const isActive = bi === activeBranchIdx
          const ci = bi % BRANCH_COLORS.length
          const color = isActive ? BRANCH_COLORS[ci] : "#27272a"
          const inner = isActive ? BRANCH_INNER[ci] : "#3f3f46"
          const y = firstY + bi * branchGap
          const count = Math.min(branch.turns.length, cappedMax)

          return (
            <g
              key={branch.id}
              className="transition-all duration-500"
              style={{ opacity: isActive ? 1 : 0.3 }}
            >
              {bi === 0 ? (
                <line x1={bpX} y1={y} x2={bpX + count * ns} y2={y} stroke={color} strokeWidth={2} />
              ) : (
                <>
                  <path
                    d={`M ${bpX} ${firstY} C ${bpX + 10} ${y - 5}, ${bpX + 20} ${y}, ${bpX + ns} ${y}`}
                    fill="none" stroke={color} strokeWidth={2}
                  />
                  {count > 1 && (
                    <line x1={bpX + ns} y1={y} x2={bpX + count * ns} y2={y} stroke={color} strokeWidth={2} />
                  )}
                </>
              )}
              {Array.from({ length: count }).map((_, ni) => (
                <g key={ni}>
                  <circle cx={bpX + (ni + 1) * ns} cy={y} r={3.5} fill="#09090b" stroke={color} strokeWidth={1.5} />
                  <circle cx={bpX + (ni + 1) * ns} cy={y} r={1.5} fill={inner} />
                </g>
              ))}
              {branch.turns.length > cappedMax && (
                <text
                  x={bpX + (count + 0.4) * ns} y={y + 3}
                  fill={isActive ? BRANCH_COLORS[ci] : "#3f3f46"}
                  fontSize="8" fontFamily="monospace"
                >
                  +{branch.turns.length - cappedMax}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

interface BranchModalProps {
  branches: Branch[]
  branchPointTurnIndex: number
  onClose: () => void
  onRedoToTurn: (branchId: string, archiveTurnIndex: number) => void
  onRedoEntireBranch: (branchId: string) => void
}

function ArchivedTurnCard({
  turn,
  archiveIndex,
  branchId,
  onRedoToHere,
}: {
  turn: ArchivedTurn
  archiveIndex: number
  branchId: string
  onRedoToHere: (branchId: string, archiveTurnIndex: number) => void
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
      <div className="p-3 space-y-2">
        {/* User message */}
        {turn.userMessage && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-zinc-300">{turn.userMessage}</div>
          </div>
        )}

        {/* Thinking preview */}
        {turn.thinkingBlocks.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-500/60 mt-1.5 shrink-0" />
            <div className="text-xs text-zinc-500 italic line-clamp-2">
              {turn.thinkingBlocks[0].slice(0, 200)}...
            </div>
          </div>
        )}

        {/* Assistant text */}
        {turn.assistantText.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-zinc-400 line-clamp-3">
              {turn.assistantText.join("\n").slice(0, 300)}
            </div>
          </div>
        )}

        {/* Tool calls */}
        {turn.toolCalls.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-500/60 mt-1.5 shrink-0" />
            <div className="flex flex-wrap gap-1">
              {turn.toolCalls.map((tc, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className={cn(
                    "text-[10px] px-1.5 py-0 h-4 font-mono",
                    tc.type === "Edit" ? "border-amber-700/50 text-amber-400" : "border-green-700/50 text-green-400"
                  )}
                >
                  {tc.type} {tc.filePath.split("/").pop()}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Redo button */}
      <div className="border-t border-zinc-800 px-3 py-1.5 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs text-blue-400 hover:text-blue-300 gap-1"
          onClick={() => onRedoToHere(branchId, archiveIndex)}
        >
          <RotateCcw className="size-3 scale-x-[-1]" />
          Redo to here
        </Button>
      </div>
    </div>
  )
}

export function BranchModal({
  branches,
  branchPointTurnIndex,
  onClose,
  onRedoToTurn,
  onRedoEntireBranch,
}: BranchModalProps) {
  const [currentIndex, setCurrentIndex] = useState(0)

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : branches.length - 1))
  }, [branches.length])

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i < branches.length - 1 ? i + 1 : 0))
  }, [branches.length])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev()
      else if (e.key === "ArrowRight") goNext()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [goPrev, goNext])

  const current = branches[currentIndex]
  if (!current) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[80vh] bg-zinc-900 border-zinc-700 flex flex-col">
        <DialogHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2 text-zinc-100">
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
              disabled={branches.length <= 1}
              aria-label="Previous branch"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="flex-1 text-center">
              <div className="text-sm font-medium text-zinc-200 truncate">
                {current.label}
              </div>
              <div className="text-[10px] text-zinc-500">
                Branch {currentIndex + 1} of {branches.length} &middot;{" "}
                {new Date(current.createdAt).toLocaleString()}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={goNext}
              disabled={branches.length <= 1}
              aria-label="Next branch"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        <Separator className="bg-zinc-800" />

        {/* Branch turns */}
        <div className="flex-1 overflow-y-auto space-y-3 py-3 px-1">
          {current.turns.map((turn, i) => (
            <ArchivedTurnCard
              key={i}
              turn={turn}
              archiveIndex={i}
              branchId={current.id}
              onRedoToHere={onRedoToTurn}
            />
          ))}
        </div>

        {/* Branch graph */}
        {branches.length > 1 && (
          <div className="shrink-0 pt-1">
            <MiniBranchGraph
              branches={branches}
              activeBranchIdx={currentIndex}
              branchPointTurnIndex={branchPointTurnIndex}
            />
          </div>
        )}

        <Separator className="bg-zinc-800" />

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between py-2">
          <span className="text-xs text-zinc-500">
            {current.turns.length} turn{current.turns.length !== 1 ? "s" : ""} in this branch
          </span>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-500 text-white gap-1.5"
            onClick={() => onRedoEntireBranch(current.id)}
          >
            <RotateCcw className="size-3.5 scale-x-[-1]" />
            Redo entire branch
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
