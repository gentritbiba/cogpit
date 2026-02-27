import { useState, memo } from "react"
import { Users, ChevronRight, ChevronDown } from "lucide-react"
import type { SubAgentMessage } from "@/lib/types"
import { buildAgentLabelMap } from "./agent-utils"
import { AgentMessageItem } from "./AgentMessageItem"

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
}: AgentPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const isOpen = expandAll || open

  if (messages.length === 0) return null

  const agentIds = [...new Set(messages.map((m) => m.agentId))]
  const agentColorMap = new Map(agentIds.map((id, i) => [id, colors[i % colors.length]]))
  const agentLabelMap = buildAgentLabelMap(messages)

  return (
    <div className={`rounded-md border border-dashed bg-elevation-1 depth-low p-3 ${style.border}`}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Users className={`w-4 h-4 shrink-0 ${style.icon}`} />
        <span className={`text-xs font-medium ${style.label}`}>
          {label}
        </span>
        {agentIds.length > 1 && (
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${style.countBadge}`}>
            {agentIds.length} {countLabel}
          </span>
        )}
        {agentIds.map((id) => {
          const color = agentColorMap.get(id)!
          return (
            <span
              key={id}
              className={`text-[10px] px-1.5 py-0 h-4 inline-flex items-center gap-1 rounded border ${color.badge}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${color.bar}`} />
              {agentLabelMap.get(id)}
            </span>
          )
        })}
        <span className="text-[10px] text-muted-foreground">
          ({messages.length} message{messages.length > 1 ? "s" : ""})
        </span>
        <span className="ml-auto">
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </span>
      </button>

      {isOpen && (
        <div className="mt-3 space-y-2">
          {messages.map((msg, i) => {
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
