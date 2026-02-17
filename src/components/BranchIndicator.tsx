import { GitFork } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

interface BranchIndicatorProps {
  branchCount: number
  onClick: () => void
}

export function BranchIndicator({ branchCount, onClick }: BranchIndicatorProps) {
  if (branchCount === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => { e.stopPropagation(); onClick() }}
          className="inline-flex items-center gap-1 rounded-full border border-purple-800/50 bg-purple-500/10 px-1.5 py-0.5 text-purple-400 hover:bg-purple-500/20 hover:text-purple-300 transition-colors"
        >
          <GitFork className="size-3" />
          <span className="text-[10px] font-mono">{branchCount}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {branchCount} branch{branchCount !== 1 ? "es" : ""} from this turn
      </TooltipContent>
    </Tooltip>
  )
}
