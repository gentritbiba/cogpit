import { GitFork } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

interface BranchIndicatorProps {
  branchCount: number
  onClick: () => void
}

export function BranchIndicator({ branchCount, onClick }: BranchIndicatorProps) {
  if (branchCount === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          variant="ghost"
          size="xs"
          onClick={(event) => { event.stopPropagation(); onClick() }}
          className="h-6 text-muted-foreground"
        />
      }>
          <GitFork data-icon="inline-start" />
          <span className="font-mono text-xs">{branchCount}</span>
      </TooltipTrigger>
      <TooltipContent>
        {branchCount} branch{branchCount !== 1 ? "es" : ""} from this turn
      </TooltipContent>
    </Tooltip>
  )
}
