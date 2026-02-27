import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { Turn } from "@/lib/types"
import { cn } from "@/lib/utils"
import { TOOL_BADGE_STYLES, toolSummary } from "./branchStyles"

// ─── Full Turn Card (parsed from JSONL) ───────────────────────

export function FullTurnCard({
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
    <div className="rounded-lg border border-border elevation-1 overflow-hidden">
      <div className="p-3 space-y-2">
        {/* User message */}
        {userText && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-foreground">{userText}</div>
          </div>
        )}

        {/* Thinking preview */}
        {turn.thinking.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-500/60 mt-1.5 shrink-0" />
            <div className="text-xs text-muted-foreground italic">
              {turn.thinking[0].thinking.slice(0, 300)}
              {turn.thinking[0].thinking.length > 300 ? "..." : ""}
            </div>
          </div>
        )}

        {/* Assistant text */}
        {turn.assistantText.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-muted-foreground">
              {turn.assistantText.join("\n")}
            </div>
          </div>
        )}

        {/* ALL tool calls */}
        {turn.toolCalls.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 mt-1.5 shrink-0" />
            <div className="flex flex-wrap gap-1">
              {turn.toolCalls.map((tc, i) => {
                const summary = toolSummary(tc)
                return (
                  <Badge
                    key={i}
                    variant="outline"
                    className={cn(
                      "text-[10px] px-1.5 py-0 h-4 font-mono",
                      TOOL_BADGE_STYLES[tc.name] ?? "border-border/50 text-muted-foreground",
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
        <div className="border-t border-border px-3 py-1.5 flex justify-end">
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

export function ArchivedTurnCard({
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
    <div className="rounded-lg border border-border elevation-1 overflow-hidden">
      <div className="p-3 space-y-2">
        {turn.userMessage && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-foreground">{turn.userMessage}</div>
          </div>
        )}
        {turn.thinkingBlocks.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-500/60 mt-1.5 shrink-0" />
            <div className="text-xs text-muted-foreground italic">
              {turn.thinkingBlocks[0].slice(0, 300)}...
            </div>
          </div>
        )}
        {turn.assistantText.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-muted-foreground">{turn.assistantText.join("\n")}</div>
          </div>
        )}
        {turn.toolCalls.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 mt-1.5 shrink-0" />
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
      <div className="border-t border-border px-3 py-1.5 flex justify-end">
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
