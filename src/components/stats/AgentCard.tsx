import { Bot } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatAgentLabel } from "@/components/timeline/agent-utils"

const AGENT_BADGE_COLORS = [
  "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
]

interface AgentCardProps {
  agentId: string
  subagentType: string | null
  agentName: string | null
  preview: string
  colorIndex: number
  isViewing: boolean
  isBackground?: boolean
  isActive?: boolean
  disabled?: boolean
  onClick: () => void
}

export { AGENT_BADGE_COLORS }

export function AgentCard({
  agentId,
  subagentType,
  agentName,
  preview,
  colorIndex,
  isViewing,
  isBackground,
  isActive,
  disabled,
  onClick,
}: AgentCardProps): JSX.Element {
  const badgeColor = AGENT_BADGE_COLORS[colorIndex % AGENT_BADGE_COLORS.length]
  const label = formatAgentLabel(agentId, subagentType, agentName)
  const iconColor = isBackground ? "text-indigo-400" : "text-cyan-400"

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full rounded border elevation-2 depth-low px-2.5 py-2 text-left transition-colors disabled:cursor-default",
        isViewing
          ? "border-blue-500/50 bg-blue-500/10 ring-1 ring-blue-500/30"
          : "border-border hover:bg-elevation-3"
      )}
      disabled={disabled}
    >
      <div className="flex items-center gap-1.5">
        <Bot className={cn("size-3 shrink-0", iconColor)} />
        <span
          className={cn(
            "inline-flex items-center rounded border px-1.5 py-0 text-[10px]",
            badgeColor
          )}
        >
          {label}
        </span>
        {isBackground && (
          <span className="text-[9px] text-violet-400/70 font-medium uppercase">bg</span>
        )}
        {isViewing && (
          <span className="text-[9px] text-blue-400 font-medium">viewing</span>
        )}
        {isActive !== undefined && (
          <span
            className={cn(
              "ml-auto inline-block size-1.5 rounded-full shrink-0",
              isActive ? "bg-green-400 animate-pulse" : "bg-muted"
            )}
            title={isActive ? "Active" : "Done"}
          />
        )}
      </div>
      {preview && (
        <p className="mt-1 truncate text-[10px] text-muted-foreground leading-snug">
          {preview}
        </p>
      )}
    </button>
  )
}
