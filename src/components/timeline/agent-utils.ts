import type { SubAgentMessage } from "@/lib/types"

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** Format: "type - shortId", falling back to just shortId when no metadata */
export function agentLabel(msg: SubAgentMessage): string {
  return formatAgentLabel(msg.agentId, msg.subagentType, msg.agentName)
}

/**
 * Standalone version for contexts that don't have SubAgentMessage objects
 * (e.g., StatsPanel, SessionInfoBar).
 */
export function formatAgentLabel(agentId: string, subagentType?: string | null, agentName?: string | null): string {
  const type = subagentType ?? agentName
  if (type) return `${type} - ${shortId(agentId)}`
  return shortId(agentId)
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
