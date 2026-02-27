import { CheckCircle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface PlanApprovalBarProps {
  allowedPrompts?: Array<{ tool: string; prompt: string }>
  onApprove: () => void
  onSend: (message: string) => void
}

export function PlanApprovalBar({ allowedPrompts, onApprove, onSend }: PlanApprovalBarProps) {
  return (
    <div className="mb-2.5 rounded-lg border border-purple-500/30 bg-purple-500/5 p-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-purple-500/20 shrink-0">
            <CheckCircle className="size-3 text-purple-400" />
          </div>
          <span className="text-xs font-medium text-purple-300">
            Plan ready for review
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            className="h-7 px-3 text-xs bg-purple-600 hover:bg-purple-500 text-white border-0"
            onClick={onApprove}
          >
            Approve
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-3 text-xs text-purple-400 hover:text-purple-300 hover:bg-purple-500/10"
            onClick={() => onSend("no")}
          >
            Reject
          </Button>
        </div>
      </div>
      {allowedPrompts && allowedPrompts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="text-[10px] text-muted-foreground self-center mr-1">Permissions requested:</span>
          {allowedPrompts.map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded border border-purple-500/20 bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-400"
            >
              {p.prompt}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
