import { memo } from "react"
import { AgentPanel } from "./AgentPanel"
import type { SubAgentMessage } from "@/lib/types"

interface BackgroundAgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
}

export const BackgroundAgentPanel = memo(function BackgroundAgentPanel({ messages, expandAll }: BackgroundAgentPanelProps) {
  return (
    <AgentPanel
      messages={messages}
      expandAll={expandAll}
      label="Background agent activity"
      countLabel="agents active"
      lazyLoad
    />
  )
})
