import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import type { Turn } from "../../../shared/session/types"
import { cn } from "@/lib/utils"
import { toolInputPreview } from "./branchStyles"
import { getToolPresentation } from "../../../shared/session/toolSummary"

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
      ? turn.userMessage.flatMap((block) => block.type === "text" ? [(block as { text: string }).text] : []).join("\n")
      : null

  return (
    <Card size="sm" className="motion-list-item gap-0 py-0">
      <CardHeader className="border-b py-2">
        <CardTitle>Turn {archiveIndex + 1}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 py-3">
        {userText && (
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span className="text-xs font-medium text-muted-foreground">You</span>
            <div className="text-sm text-foreground">{userText}</div>
          </div>
        )}

        {turn.thinking.length > 0 && (
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span className="text-xs font-medium text-muted-foreground">Thinking</span>
            <div className="text-xs text-muted-foreground italic">
              {turn.thinking[0].thinking.slice(0, 300)}
              {turn.thinking[0].thinking.length > 300 ? "..." : ""}
            </div>
          </div>
        )}

        {turn.assistantText.length > 0 && (
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span className="text-xs font-medium text-success">Assistant</span>
            <div className="text-sm text-muted-foreground">
              {turn.assistantText.join("\n")}
            </div>
          </div>
        )}

        {turn.toolCalls.length > 0 && (
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span className="text-xs font-medium text-muted-foreground">Tools</span>
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              {turn.toolCalls.map((tc) => {
                const presentation = getToolPresentation(tc)
                const summary = toolInputPreview(tc) || presentation.summary
                return (
                  <span
                    key={tc.id}
                    className={cn(
                      "font-mono text-xs text-muted-foreground",
                      tc.isError && "text-destructive",
                    )}
                  >
                    {presentation.label}{summary ? ` ${summary}` : ""}
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>

      {onRedoToHere && (
        <CardFooter className="justify-end py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRedoToHere(branchId, archiveIndex)}
          >
            <RotateCcw data-icon="inline-start" className="scale-x-[-1]" />
            Redo to here
          </Button>
        </CardFooter>
      )}
    </Card>
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
    <Card size="sm" className="motion-list-item gap-0 py-0">
      <CardHeader className="border-b py-2">
        <CardTitle>Turn {archiveIndex + 1}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 py-3">
        {turn.userMessage && (
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span className="text-xs font-medium text-muted-foreground">You</span>
            <div className="text-sm text-foreground">{turn.userMessage}</div>
          </div>
        )}
        {turn.thinkingBlocks.length > 0 && (
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span className="text-xs font-medium text-muted-foreground">Thinking</span>
            <div className="text-xs text-muted-foreground italic">
              {turn.thinkingBlocks[0].slice(0, 300)}...
            </div>
          </div>
        )}
        {turn.assistantText.length > 0 && (
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span className="text-xs font-medium text-success">Assistant</span>
            <div className="text-sm text-muted-foreground">{turn.assistantText.join("\n")}</div>
          </div>
        )}
        {turn.toolCalls.length > 0 && (
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span className="text-xs font-medium text-muted-foreground">Tools</span>
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              {turn.toolCalls.map((tc, i) => (
                <span
                  key={i}
                  className="font-mono text-xs text-muted-foreground"
                >
                  {tc.type} {tc.filePath.split("/").pop()}
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-end py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRedoToHere(branchId, archiveIndex)}
        >
          <RotateCcw data-icon="inline-start" className="scale-x-[-1]" />
          Redo to here
        </Button>
      </CardFooter>
    </Card>
  )
}
