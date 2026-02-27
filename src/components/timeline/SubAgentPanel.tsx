import { memo } from "react"
import { AgentPanel } from "./AgentPanel"
import type { SubAgentMessage } from "@/lib/types"

interface SubAgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
}

const SUB_AGENT_COLORS = [
  { badge: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30", bar: "bg-indigo-400" },
  { badge: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30", bar: "bg-cyan-400" },
  { badge: "bg-amber-500/15 text-amber-300 border-amber-500/30", bar: "bg-amber-400" },
  { badge: "bg-rose-500/15 text-rose-300 border-rose-500/30", bar: "bg-rose-400" },
  { badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", bar: "bg-emerald-400" },
]

const SUB_AGENT_STYLE = {
  border: "border-indigo-500/30",
  icon: "text-indigo-400",
  label: "text-indigo-400",
  countBadge: "text-indigo-300 bg-indigo-500/20",
}

export const SubAgentPanel = memo(function SubAgentPanel({ messages, expandAll }: SubAgentPanelProps) {
  return (
    <AgentPanel
      messages={messages}
      expandAll={expandAll}
      label="Sub-agent activity"
      countLabel="subagents active"
      style={SUB_AGENT_STYLE}
      colors={SUB_AGENT_COLORS}
    />
  )
})
