import { useState, memo, useMemo } from "react"
import { Users, ChevronRight, ChevronDown, Clock, Wrench, CheckCircle2, XCircle, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import type { SubAgentMessage } from "@/lib/types"
import { buildAgentLabelMap } from "./agent-utils"
import { AgentMessageItem } from "./AgentMessageItem"
import { useSubagentContent } from "@/hooks/useSubagentContent"

interface AgentColor {
  badge: string
  bar: string
}

interface AgentPanelStyle {
  border: string
  icon: string
  label: string
  countBadge: string
}

interface AgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
  label: string
  countLabel: string
  style: AgentPanelStyle
  colors: AgentColor[]
  thinkingIconColor?: string
  /** Enable lazy loading of subagent JSONL files for async_launched agents */
  lazyLoad?: boolean
}

/**
 * Shared collapsible panel for sub-agent and background-agent activity.
 * The two use cases differ only in color palette and labeling.
 */
export const AgentPanel = memo(function AgentPanel({
  messages,
  expandAll,
  label,
  countLabel,
  style,
  colors,
  thinkingIconColor,
  lazyLoad = false,
}: AgentPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  const { enrichedMessages: displayMessages, isLoading } = useSubagentContent(messages, lazyLoad && isOpen)

  const agentIds = useMemo(() => [...new Set(displayMessages.map((m) => m.agentId))], [displayMessages])
  const agentColorMap = useMemo(() => new Map(agentIds.map((id, i) => [id, colors[i % colors.length]])), [agentIds, colors])
  const agentLabelMap = useMemo(() => buildAgentLabelMap(displayMessages), [displayMessages])

  // Aggregate summary stats from original messages (they have durationMs/toolUseCount from the launch event)
  const summaryStats = useMemo(() => {
    let totalDuration = 0
    let totalToolUses = 0
    let hasSummary = false
    let allCompleted = true
    for (const m of messages) {
      if (m.durationMs != null) { totalDuration += m.durationMs; hasSummary = true }
      if (m.toolUseCount != null) totalToolUses += m.toolUseCount
      if (m.status && m.status !== "completed") allCompleted = false
    }
    if (!hasSummary) return null
    return { totalDuration, totalToolUses, allCompleted }
  }, [messages])

  const visibleMessageCount = useMemo(
    () => displayMessages.filter((m) => m.text.length > 0 || m.thinking.length > 0 || m.toolCalls.length > 0).length,
    [displayMessages]
  )

  if (messages.length === 0) return null

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full min-w-0 text-left py-1 hover:opacity-80 transition-opacity flex-wrap"
      >
        {isOpen
          ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <Users className={cn("w-3.5 h-3.5 shrink-0", style.icon)} />
        <span className={cn("text-xs font-medium", style.label)}>
          {label}
        </span>
        {agentIds.length > 1 && (
          <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded-full", style.countBadge)}>
            {agentIds.length} {countLabel}
          </span>
        )}
        {agentIds.map((id) => {
          const color = agentColorMap.get(id)!
          return (
            <span
              key={id}
              className={cn("text-[10px] px-1.5 py-0 h-4 inline-flex items-center gap-1 rounded border", color.badge)}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full", color.bar)} />
              {agentLabelMap.get(id)}
            </span>
          )
        })}
        {summaryStats ? (
          <span className="text-[10px] text-muted-foreground/50 inline-flex items-center gap-2">
            {summaryStats.allCompleted
              ? <CheckCircle2 className="w-3 h-3 text-green-400" />
              : <XCircle className="w-3 h-3 text-red-400" />}
            <span className="inline-flex items-center gap-0.5">
              <Clock className="w-3 h-3" />
              {formatDuration(summaryStats.totalDuration)}
            </span>
            {summaryStats.totalToolUses > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Wrench className="w-3 h-3" />
                {summaryStats.totalToolUses}
              </span>
            )}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground/50">
            ({visibleMessageCount} message{visibleMessageCount !== 1 ? "s" : ""})
          </span>
        )}
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2">
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading agent output...
            </div>
          )}
          {displayMessages.map((msg, i) => {
            const color = agentColorMap.get(msg.agentId) ?? colors[0]
            return (
              <AgentMessageItem
                key={i}
                message={msg}
                expandAll={expandAll}
                barColor={color.bar}
                thinkingIconColor={thinkingIconColor}
              />
            )
          })}
        </div>
      )}
    </div>
  )
})
