import { memo } from "react"
import { AgentPanel } from "./AgentPanel"
import type { SubAgentMessage } from "../../../shared/session/types"

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
