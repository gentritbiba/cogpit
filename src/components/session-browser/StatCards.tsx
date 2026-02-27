import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatTokenCount, formatCost } from "@/lib/format"

// ── SidebarStatCard ────────────────────────────────────────────────────────

interface SidebarStatCardProps {
  icon: React.ReactNode
  label: string
  value: string
  variant?: "default" | "error"
  tooltip?: string
}

export function SidebarStatCard({
  icon,
  label,
  value,
  variant = "default",
  tooltip,
}: SidebarStatCardProps): React.ReactElement {
  const isError = variant === "error" && Number(value) > 0

  const card = (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-md border px-2 py-1.5",
        isError
          ? "border-red-900/50 bg-red-950/30 depth-low"
          : "border-border/40 elevation-2 depth-low"
      )}
    >
      <div className="flex items-center gap-1 text-muted-foreground">
        {icon}
        <span className="text-[10px]">{label}</span>
      </div>
      <span
        className={cn(
          "text-sm font-semibold",
          isError ? "text-red-400" : "text-foreground"
        )}
      >
        {value}
      </span>
    </div>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{card}</TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
    )
  }

  return card
}

// ── BreakdownRow ───────────────────────────────────────────────────────────

interface BreakdownRowProps {
  label: string
  input: number
  output: number
  cost: number
}

export function BreakdownRow({ label, input, output, cost }: BreakdownRowProps): React.ReactElement {
  return (
    <div className="flex items-center gap-1 text-[10px]">
      <span className="flex-1 truncate text-muted-foreground">{label}</span>
      <span className="font-mono text-blue-400 w-12 text-right">{formatTokenCount(input)}</span>
      <span className="text-muted-foreground/50">in</span>
      <span className="font-mono text-emerald-400 w-10 text-right">{formatTokenCount(output)}</span>
      <span className="text-muted-foreground/50">out</span>
      <span className="font-mono text-amber-400 w-12 text-right">{formatCost(cost)}</span>
    </div>
  )
}
