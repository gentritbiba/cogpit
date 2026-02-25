import { memo } from "react"
import { Loader2 } from "lucide-react"
import { UserMessage } from "./timeline/UserMessage"

interface PendingTurnPreviewProps {
  message: string
  turnNumber: number
  statusText?: string
  elapsedSec?: number
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

export const PendingTurnPreview = memo(function PendingTurnPreview({
  message,
  turnNumber,
  statusText = "Agent is working...",
  elapsedSec,
}: PendingTurnPreviewProps) {
  return (
    <div className="group relative py-5 px-4">
      {/* Turn header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center justify-center w-6 h-6 rounded-full bg-elevation-2 border border-border/50 text-[10px] font-mono text-muted-foreground shrink-0">
          {turnNumber}
        </div>
      </div>

      {/* Timeline content */}
      <div className="space-y-4">
        {/* User message card — reuses the same component as real turns */}
        <div className="rounded-lg bg-blue-500/[0.06] border border-blue-500/10 p-3">
          <UserMessage content={message} />
        </div>

        {/* Agent working indicator */}
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-blue-400" />
          <span className="text-xs">{statusText}</span>
          {elapsedSec !== undefined && elapsedSec > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
              {formatElapsed(elapsedSec)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
})
