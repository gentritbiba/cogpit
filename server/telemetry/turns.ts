import type { Turn } from "../../shared/session/types"
import { builtInToolName } from "../../shared/session/toolSummary"
import { publicModelName } from "../agents/publicModels"
import { settingToken, type TelemetryEvents } from "./events"

/** A session's turns as its transcript holds them, read only when it changed. */
export interface SessionTurns {
  agent: string
  mtimeMs: number
  /** Whether a turn is in progress, so the last one is not finished yet. */
  running: boolean
  turns: Turn[]
}

/** Reads a session's transcript, or null when it is gone or unchanged since `knownMtimeMs`. */
export type ReadSessionTurns = (sessionId: string, knownMtimeMs: number | undefined) => Promise<SessionTurns | null>

export interface FinishedTurn {
  startedAt: number
  turn: TelemetryEvents["turn.completed"]
  tools: TelemetryEvents["tool.used"][]
}

/** The turns that finished after `reportedThrough`, the start time of the last turn already reported. */
export function finishedTurns(session: SessionTurns, reportedThrough: number): FinishedTurn[] {
  const finished = session.running ? session.turns.slice(0, -1) : session.turns
  const events: FinishedTurn[] = []
  for (const turn of finished) {
    const startedAt = Date.parse(turn.timestamp)
    if (!Number.isFinite(startedAt) || startedAt <= reportedThrough || turn.isFragment) continue
    events.push({ startedAt, ...turnEvents(session.agent, turn) })
  }
  return events
}

function turnEvents(agent: string, turn: Turn): Omit<FinishedTurn, "startedAt"> {
  const tools = new Map<string, { calls: number; errors: number }>()
  let toolErrors = 0
  let linesAdded = 0
  let linesRemoved = 0
  for (const call of turn.toolCalls) {
    const tool = builtInToolName(call.name)
    const counts = tools.get(tool) ?? { calls: 0, errors: 0 }
    counts.calls += 1
    if (call.isError) {
      counts.errors += 1
      toolErrors += 1
    }
    tools.set(tool, counts)
    linesAdded += call.diffLineCounts?.add ?? 0
    linesRemoved += call.diffLineCounts?.del ?? 0
  }
  const usage = turn.tokenUsage
  const model = publicModelName(turn.model)
  const effort = settingToken(turn.effort)
  const compaction = turn.compactionMeta?.trigger
  return {
    turn: {
      agent,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(turn.durationMs !== null && turn.durationMs >= 0 ? { durationMs: turn.durationMs } : {}),
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
      reasoningTokens: usage?.output_tokens_details?.thinking_tokens ?? 0,
      fastMode: usage?.speed === "fast",
      toolCalls: turn.toolCalls.length,
      toolErrors,
      linesAdded,
      linesRemoved,
      subagents: new Set(turn.subAgentActivity.map((message) => message.agentId)).size,
      ...(compaction ? { compaction } : {}),
      skill: Boolean(turn.attribution?.skill),
      plugin: Boolean(turn.attribution?.plugin),
      mcp: Boolean(turn.attribution?.mcpServer) || tools.has("mcp"),
      images: Array.isArray(turn.userMessage) ? turn.userMessage.filter((block) => block.type === "image").length : 0,
    },
    tools: [...tools].map(([tool, counts]) => ({ agent, tool, ...counts })),
  }
}
