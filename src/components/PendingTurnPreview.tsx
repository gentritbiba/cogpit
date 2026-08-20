import { memo } from "react"
import { UserMessage } from "./timeline/UserMessage"
import { Badge } from "@/components/ui/badge"

interface PendingTurnPreviewProps {
  message: string
  turnNumber: number
}

export const PendingTurnPreview = memo(function PendingTurnPreview({
  message,
  turnNumber,
}: PendingTurnPreviewProps) {
  return (
    <div className="group relative px-4 py-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">Turn {turnNumber}</span>
        <Badge variant="outline">Queued</Badge>
      </div>
      <div className="rounded-lg border border-dashed bg-prompt-surface p-3">
        <UserMessage content={message} timestamp="" />
      </div>
    </div>
  )
})
