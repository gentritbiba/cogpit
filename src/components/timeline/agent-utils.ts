import type { SubAgentMessage } from "@/lib/types"

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

export function formatAgentLabel(agentId: string, subagentType?: string | null, agentName?: string | null): string {
  const type = subagentType ?? agentName
  if (type) return `${type} - ${shortId(agentId)}`
  return shortId(agentId)
}

export function buildAgentLabelMap(messages: SubAgentMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (!map.has(msg.agentId)) {
      map.set(msg.agentId, formatAgentLabel(msg.agentId, msg.subagentType, msg.agentName))
    }
  }
  return map
}
