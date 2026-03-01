import { memo } from "react"
import { UserMessage } from "./timeline/UserMessage"

interface PendingTurnPreviewProps {
  message: string
  turnNumber: number
}

export const PendingTurnPreview = memo(function PendingTurnPreview({
  message,
  turnNumber,
}: PendingTurnPreviewProps) {
  return (
    <div className="group relative py-5 px-4">
      {/* Turn header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center justify-center w-6 h-6 rounded-full bg-elevation-2 border border-border/50 text-[10px] font-mono text-muted-foreground shrink-0">
          {turnNumber}
        </div>
      </div>

      <div className="rounded-lg bg-blue-500/[0.06] border border-blue-500/10 p-3">
        <UserMessage content={message} />
      </div>
    </div>
  )
})
