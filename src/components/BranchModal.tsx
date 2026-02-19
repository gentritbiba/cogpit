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
import type { Branch, Turn, ToolCall as ParsedToolCall, ArchivedTurn } from "@/lib/types"
import { parseSession } from "@/lib/parser"
import { cn } from "@/lib/utils"

// ─── Branch Colors ────────────────────────────────────────────

const BRANCH_COLORS = ["#3b82f6", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899", "#22c55e"]
const BRANCH_INNER = ["#60a5fa", "#c084fc", "#fbbf24", "#22d3ee", "#f472b6", "#4ade80"]

// ─── Tool style map ───────────────────────────────────────────

const TOOL_BADGE_STYLES: Record<string, string> = {
  Read: "border-blue-700/50 text-blue-400",
  Edit: "border-amber-700/50 text-amber-400",
  Write: "border-green-700/50 text-green-400",
  Bash: "border-red-700/50 text-red-400",
  Grep: "border-purple-700/50 text-purple-400",
  Glob: "border-cyan-700/50 text-cyan-400",
  Task: "border-indigo-700/50 text-indigo-400",
  WebFetch: "border-teal-700/50 text-teal-400",
  WebSearch: "border-teal-700/50 text-teal-400",
}

function toolSummary(tc: ParsedToolCall): string {
  const fp = (tc.input.file_path ?? tc.input.path ?? "") as string
  if (fp) return fp.split("/").pop() || fp
  const cmd = tc.input.command as string | undefined
  if (cmd) return cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd
  const pat = tc.input.pattern as string | undefined
  if (pat) return pat.length > 30 ? pat.slice(0, 27) + "..." : pat
  const query = tc.input.query as string | undefined
  if (query) return query.length > 30 ? query.slice(0, 27) + "..." : query
  return ""
}

// ─── Mini Branch Graph ────────────────────────────────────────

function MiniBranchGraph({
  branches,
  activeBranchIdx,
  branchPointTurnIndex,
}: {
  branches: DisplayBranch[]
  activeBranchIdx: number
  branchPointTurnIndex: number
}) {
  const numBranches = branches.length
  if (numBranches === 0) return null

  const sharedCount = Math.min(branchPointTurnIndex + 1, 5)
  const maxBranchTurns = Math.max(...branches.map((b) => b.graphTurnCount), 1)
  const cappedMax = Math.min(maxBranchTurns, 6)

  const ss = 25
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
          const count = Math.min(branch.graphTurnCount, cappedMax)

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
              {branch.graphTurnCount > cappedMax && (
                <text
                  x={bpX + (count + 0.4) * ns} y={y + 3}
                  fill={isActive ? BRANCH_COLORS[ci] : "#3f3f46"}
                  fontSize="8" fontFamily="monospace"
                >
                  +{branch.graphTurnCount - cappedMax}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ─── Full Turn Card (parsed from JSONL) ───────────────────────

function FullTurnCard({
  turn,
  archiveIndex,
  branchId,
  onRedoToHere,
}: {
  turn: Turn
  archiveIndex: number
  branchId: string
  onRedoToHere?: (branchId: string, archiveTurnIndex: number) => void
}) {
  const userText = typeof turn.userMessage === "string"
    ? turn.userMessage
    : Array.isArray(turn.userMessage)
      ? turn.userMessage.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n")
      : null

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
      <div className="p-3 space-y-2">
        {/* User message */}
        {userText && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-zinc-300">{userText}</div>
          </div>
        )}

        {/* Thinking preview */}
        {turn.thinking.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-500/60 mt-1.5 shrink-0" />
            <div className="text-xs text-zinc-500 italic">
              {turn.thinking[0].thinking.slice(0, 300)}
              {turn.thinking[0].thinking.length > 300 ? "..." : ""}
            </div>
          </div>
        )}

        {/* Assistant text */}
        {turn.assistantText.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-zinc-400">
              {turn.assistantText.join("\n")}
            </div>
          </div>
        )}

        {/* ALL tool calls */}
        {turn.toolCalls.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-500/60 mt-1.5 shrink-0" />
            <div className="flex flex-wrap gap-1">
              {turn.toolCalls.map((tc) => {
                const summary = toolSummary(tc)
                return (
                  <Badge
                    key={tc.id || `tc-${tc.name}`}
                    variant="outline"
                    className={cn(
                      "text-[10px] px-1.5 py-0 h-4 font-mono",
                      TOOL_BADGE_STYLES[tc.name] ?? "border-zinc-700/50 text-zinc-400",
                      tc.isError && "border-red-700/50 text-red-400"
                    )}
                  >
                    {tc.name}{summary ? ` ${summary}` : ""}
                  </Badge>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Redo button (hidden for current branch) */}
      {onRedoToHere && (
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
      )}
    </div>
  )
}

// ─── Fallback for unparseable branches ────────────────────────

function ArchivedTurnCard({
  turn,
  archiveIndex,
  branchId,
  onRedoToHere,
}: {
  turn: { userMessage: string | null; thinkingBlocks: string[]; assistantText: string[]; toolCalls: { type: string; filePath: string }[] }
  archiveIndex: number
  branchId: string
  onRedoToHere: (branchId: string, archiveTurnIndex: number) => void
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
      <div className="p-3 space-y-2">
        {turn.userMessage && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-zinc-300">{turn.userMessage}</div>
          </div>
        )}
        {turn.thinkingBlocks.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-500/60 mt-1.5 shrink-0" />
            <div className="text-xs text-zinc-500 italic">
              {turn.thinkingBlocks[0].slice(0, 300)}...
            </div>
          </div>
        )}
        {turn.assistantText.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-zinc-400">{turn.assistantText.join("\n")}</div>
          </div>
        )}
        {turn.toolCalls.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-500/60 mt-1.5 shrink-0" />
            <div className="flex flex-wrap gap-1">
              {turn.toolCalls.map((tc) => (
                <Badge
                  key={`${tc.type}-${tc.filePath}`}
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

// ─── Main Component ───────────────────────────────────────────

// ─── Entry for the unified branch list (current + archived) ──

interface DisplayBranch {
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
      <DialogContent className="max-w-2xl max-h-[80vh] bg-zinc-900 border-zinc-700 flex flex-col !top-[10%] !translate-y-0">
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
              disabled={totalCount <= 1}
              aria-label="Previous branch"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="flex-1 text-center">
              <div className="text-sm font-medium text-zinc-200 truncate">
                {current.label}
                {isCurrent && (
                  <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0 h-4 border-green-700/50 text-green-400">
                    active
                  </Badge>
                )}
              </div>
              <div className="text-[10px] text-zinc-500">
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

        <Separator className="bg-zinc-800" />

        {/* Branch graph — at the top */}
        <div className="shrink-0">
          <MiniBranchGraph
            branches={displayBranches}
            activeBranchIdx={currentIndex}
            branchPointTurnIndex={branchPointTurnIndex}
          />
        </div>

        <Separator className="bg-zinc-800" />

        {/* Branch turns — full content, scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-3 py-3 px-1">
          {current.fullTurns
            ? current.fullTurns.map((turn, i) => (
                <FullTurnCard
                  key={turn.id || `turn-${i}`}
                  turn={turn}
                  archiveIndex={i}
                  branchId={current.id}
                  onRedoToHere={isCurrent ? undefined : onRedoToTurn}
                />
              ))
            : current.archivedTurns?.map((turn, i) => (
                <ArchivedTurnCard
                  key={`archived-${turn.index}`}
                  turn={turn}
                  archiveIndex={i}
                  branchId={current.id}
                  onRedoToHere={onRedoToTurn}
                />
              ))
          }
        </div>

        <Separator className="bg-zinc-800" />

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between py-2">
          <span className="text-xs text-zinc-500">
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
