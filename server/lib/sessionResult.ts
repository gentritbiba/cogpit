import { readFile } from "../helpers"
import { findJsonlPath } from "../sessionPaths"
import { parseSessionFileChanges } from "../routes/session-file-changes"
import { parseSession } from "../../shared/session/parser"
import { scopeParsedSession } from "../../shared/session/instances"
import { storeForPath } from "../agents"
import type { Turn } from "../../shared/session/types"

/**
 * What a session produced, sized for an agent's context: the final reply of a
 * turn, not the narration before it, and the net file changes of the whole
 * session. `/api/session-context` stays the place to drill into full turns.
 */

export interface SessionResult {
  sessionId: string
  cwd: string
  model: string
  turnCount: number
  turn: {
    index: number
    userMessage: string | null
    /** The last text the agent wrote in the turn — its answer. */
    reply: string | null
    toolCalls: number
    toolErrors: number
    durationMs: number | null
  } | null
  filesChanged: Array<{ path: string; type: string; additions: number; deletions: number }>
  tokens: { input: number; output: number }
}

function userText(turn: Turn): string | null {
  const message = turn.userMessage
  if (message === null) return null
  if (typeof message === "string") return message
  const text = message.flatMap((block) => (block.type === "text" ? [block.text] : []))
  return text.length > 0 ? text.join("\n") : null
}

function finalReply(turn: Turn): string | null {
  for (let i = turn.contentBlocks.length - 1; i >= 0; i--) {
    const block = turn.contentBlocks[i]
    if (block.kind === "text" && block.text.length > 0) return block.text.join("\n\n")
  }
  return null
}

/** Null when the session does not exist; `turnIndex` defaults to the last turn. */
export async function readSessionResult(
  sessionId: string,
  turnIndex?: number,
): Promise<SessionResult | null> {
  const filePath = await findJsonlPath(sessionId)
  if (!filePath) return null
  const content = await readFile(filePath, "utf-8")
  const session = scopeParsedSession(parseSession(content), storeForPath(filePath)?.instanceId ?? "default")
  const { changes } = await parseSessionFileChanges(content, false)

  const index = turnIndex ?? session.turns.length - 1
  const turn = session.turns[index]
  return {
    sessionId,
    cwd: session.cwd,
    model: session.model,
    turnCount: session.turns.length,
    turn: turn
      ? {
          index,
          userMessage: userText(turn),
          reply: finalReply(turn),
          toolCalls: turn.toolCalls.length,
          toolErrors: turn.toolCalls.filter((call) => call.isError).length,
          durationMs: turn.durationMs ?? null,
        }
      : null,
    filesChanged: changes
      .filter((change) => !change.isError)
      .map((change) => ({
        path: change.filePath,
        type: change.type,
        additions: change.additions,
        deletions: change.deletions,
      })),
    tokens: { input: session.stats.totalInputTokens, output: session.stats.totalOutputTokens },
  }
}
