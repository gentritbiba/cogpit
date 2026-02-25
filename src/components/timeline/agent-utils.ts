import type { SubAgentMessage } from "@/lib/types"

export function agentLabel(msg: SubAgentMessage): string {
  const name = msg.agentName
  const type = msg.subagentType
  if (name && type) return `${name} - ${type}`
  if (name) return name
  if (type) return type
  return msg.agentId.length > 8 ? msg.agentId.slice(0, 8) : msg.agentId
}

export function buildAgentLabelMap(messages: SubAgentMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (!map.has(msg.agentId)) {
      map.set(msg.agentId, agentLabel(msg))
    }
  }
  return map
}
