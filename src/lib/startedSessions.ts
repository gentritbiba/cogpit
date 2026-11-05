import { useSessionContextOptional } from "@/contexts/SessionContext"
import { DEFAULT_AGENT_KIND, parseAgentKind, type AgentKind } from "@/lib/agents"
import { crewStarts, startedIds } from "@/lib/crewCommands"
import type { Turn } from "../../shared/session/types"
import { getCommandText } from "../../shared/session/toolSummary"

export interface StartedSession {
  name?: string
  kind: AgentKind
}

const cache = new WeakMap<readonly Turn[], ReadonlyMap<string, StartedSession>>()
const NONE: ReadonlyMap<string, StartedSession> = new Map()

/**
 * The sessions a transcript started with `cogpit-session new`, by id, with
 * the name and provider it gave them. It names a session the session list
 * does not hold, such as one on another machine. Read once per transcript
 * update, whichever turn asks.
 */
export function startedSessions(turns: readonly Turn[]): ReadonlyMap<string, StartedSession> {
  const cached = cache.get(turns)
  if (cached) return cached
  const started = new Map<string, StartedSession>()
  for (const turn of turns) {
    for (const toolCall of turn.toolCalls) {
      const command = getCommandText(toolCall.input)
      if (!command.includes("cogpit-session") || !toolCall.result) continue
      const starts = crewStarts(command)
      startedIds(toolCall.result, command).forEach((sessionId, index) => {
        const flags = starts[index]?.flags
        if (sessionId) started.set(sessionId, { name: flags?.name, kind: parseAgentKind(flags?.agent, DEFAULT_AGENT_KIND) })
      })
    }
  }
  cache.set(turns, started)
  return started
}

/** What the open transcript recorded about starting `sessionId`, if it did. */
export function useStartedSession(sessionId: string): StartedSession | undefined {
  const turns = useSessionContextOptional()?.session?.turns
  return (turns ? startedSessions(turns) : NONE).get(sessionId)
}
