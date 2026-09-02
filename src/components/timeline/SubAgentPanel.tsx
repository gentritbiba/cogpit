import { memo } from "react"
import { AgentPanel } from "./AgentPanel"
import type { SubAgentMessage } from "../../../shared/session/types"

interface SubAgentPanelProps {
  messages: SubAgentMessage[]
  expandAll: boolean
}

export const SubAgentPanel = memo(function SubAgentPanel({ messages, expandAll }: SubAgentPanelProps) {
  return (
    <AgentPanel
      messages={messages}
      expandAll={expandAll}
      label="Sub-agent activity"
      countLabel="subagents active"
      lazyLoad
    />
  )
})
