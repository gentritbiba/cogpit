import { memo } from "react"
import { AgentPanel } from "./AgentPanel"
import type { SubAgentMessage } from "@/lib/types"

interface BackgroundAgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
}

const BACKGROUND_AGENT_COLORS = [
  { badge: "bg-violet-500/15 text-violet-300 border-violet-500/30", bar: "bg-violet-400" },
  { badge: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30", bar: "bg-fuchsia-400" },
  { badge: "bg-purple-500/15 text-purple-300 border-purple-500/30", bar: "bg-purple-400" },
  { badge: "bg-pink-500/15 text-pink-300 border-pink-500/30", bar: "bg-pink-400" },
  { badge: "bg-sky-500/15 text-sky-300 border-sky-500/30", bar: "bg-sky-400" },
]

const BACKGROUND_AGENT_STYLE = {
  border: "border-violet-500/30",
  icon: "text-violet-400",
  label: "text-violet-400",
  countBadge: "text-violet-300 bg-violet-500/20",
}

export const BackgroundAgentPanel = memo(function BackgroundAgentPanel({ messages, expandAll }: BackgroundAgentPanelProps) {
  return (
    <AgentPanel
      messages={messages}
      expandAll={expandAll}
      label="Background agent activity"
      countLabel="agents active"
      style={BACKGROUND_AGENT_STYLE}
      colors={BACKGROUND_AGENT_COLORS}
      thinkingIconColor="text-violet-400"
    />
  )
})
