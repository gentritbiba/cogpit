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

/**
 * agentId → Task/Agent tool_use id, the key for an agent's live stream.
 *
 * A tool id shared by several agents means they were mis-attributed upstream
 * (see subagentWatcher's prompt matching). Keying off it would replay one
 * agent's stream under every sibling, so contested ids are dropped instead —
 * sessions recorded before that fix still carry the bad mapping on disk.
 */
export function buildParentToolByAgent(messages: SubAgentMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (msg.parentToolUseId && !map.has(msg.agentId)) map.set(msg.agentId, msg.parentToolUseId)
  }

  const agentsPerTool = new Map<string, number>()
  for (const toolId of map.values()) {
    agentsPerTool.set(toolId, (agentsPerTool.get(toolId) ?? 0) + 1)
  }
  for (const [agentId, toolId] of map) {
    if ((agentsPerTool.get(toolId) ?? 0) > 1) map.delete(agentId)
  }
  return map
}
