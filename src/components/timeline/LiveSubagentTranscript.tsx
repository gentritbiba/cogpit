import { memo } from "react"
import { useStreamingOverlay } from "@/contexts/StreamingOverlayContext"
import { messagesForToolUse } from "@/lib/streamingOverlay"

/**
 * Live tail of a running subagent's streamed output, rendered inside its
 * Task/Agent ToolCallCard while the tool has no result yet. Shows the last
 * few lines of accumulated text/thinking so the subagent's progress is
 * visible as it happens instead of only after it finishes.
 */

const MAX_TAIL_LINES = 10

export const LiveSubagentTranscript = memo(function LiveSubagentTranscript({
  toolUseId,
}: {
  toolUseId: string
}) {
  const overlay = useStreamingOverlay()
  const messages = messagesForToolUse(overlay, toolUseId)
  if (messages.length === 0) return null

  // Join all visible block text in arrival order, keep the tail.
  const text = messages
    .flatMap((m) => m.blocks)
    .filter((b) => b.blockType !== "tool_use" && b.text)
    .map((b) => b.text)
    .join("\n")
  if (!text) return null

  const lines = text.split("\n")
  const tail = lines.slice(-MAX_TAIL_LINES)

  return (
    <div
      className="mt-2 rounded-md border border-border/40 bg-elevation-2/50 px-3 py-2"
      data-testid="live-subagent-transcript"
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">live</span>
      </div>
      <div className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-40 overflow-hidden">
        {lines.length > MAX_TAIL_LINES && <div className="text-muted-foreground/50">…</div>}
        {tail.join("\n")}
      </div>
    </div>
  )
})
