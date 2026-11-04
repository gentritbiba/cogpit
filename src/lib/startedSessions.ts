import { useSessionContextOptional } from "@/contexts/SessionContext"
import { DEFAULT_AGENT_KIND, parseAgentKind, type AgentKind } from "@/lib/agents"
import { crewStarts, startedIds } from "@/lib/crewCommands"
import { parseTaskNotifications, type TaskNotification } from "@/lib/userMessageContent"
import { getUserMessageText } from "../../shared/session/parser"
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

const outcomeCache = new WeakMap<readonly Turn[], ReadonlyMap<string, TaskNotification>>()
const NO_OUTCOMES: ReadonlyMap<string, TaskNotification> = new Map()

/**
 * How background tasks the transcript launched came out, by the call that
 * launched them: a background agent's call only returns a receipt, and its
 * result reaches the session later as a task notification.
 */
export function taskOutcomes(turns: readonly Turn[]): ReadonlyMap<string, TaskNotification> {
  const cached = outcomeCache.get(turns)
  if (cached) return cached
  const outcomes = new Map<string, TaskNotification>()
  const read = (text: string) => {
    if (!text.includes("<task-notification>")) return
    for (const notification of parseTaskNotifications(text).notifications) {
      if (notification.toolUseId) outcomes.set(notification.toolUseId, notification)
    }
  }
  for (const turn of turns) {
    if (turn.userMessage) read(getUserMessageText(turn.userMessage))
    for (const block of turn.contentBlocks) if (block.kind === "task_notification") read(block.content)
  }
  outcomeCache.set(turns, outcomes)
  return outcomes
}

/** The notification that reported the background task `toolUseId` launched, once one has. */
export function useTaskOutcome(toolUseId: string): TaskNotification | undefined {
  const turns = useSessionContextOptional()?.session?.turns
  return (turns ? taskOutcomes(turns) : NO_OUTCOMES).get(toolUseId)
}
