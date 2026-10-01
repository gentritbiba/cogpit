import type {
  ElicitationAction,
  ElicitationContent,
  MissionControlElicitation,
} from "../../shared/contracts/agentPrompts"
import {
  getSDKElicitations,
  listAgentPromptSessionIds,
  resolveElicitation,
} from "../sdk-session"
import { codexAppServer } from "./codexAppServer"
import { AgentRuntimeError } from "./runtimeTypes"

/**
 * MCP elicitations parked on a live session, across the agents that relay
 * them: Claude through the SDK's `onElicitation` callback, Codex as a request
 * from its app-server. Copilot sessions are started without elicitation
 * support, so there is nothing of theirs to list.
 *
 * Read from the live resolver maps, so a listed elicitation is one that can
 * still be answered.
 */

export interface ElicitationAnswer {
  action: ElicitationAction
  content?: ElicitationContent
}

function codexElicitations(): MissionControlElicitation[] {
  return codexAppServer.listElicitationThreadIds().flatMap((threadId) =>
    codexAppServer.listPendingElicitations(threadId).map((pending) => ({
      sessionId: threadId,
      requestId: String(pending.requestId),
      serverName: pending.serverName,
      message: pending.message,
      mode: pending.mode,
      ...(pending.url && { url: pending.url }),
      askedAt: pending.requestedAt,
      fields: pending.fields,
    })),
  )
}

export function listPendingElicitations(): MissionControlElicitation[] {
  return [
    ...listAgentPromptSessionIds().flatMap((sessionId) => getSDKElicitations(sessionId)),
    ...codexElicitations(),
  ]
}

/** False when no agent holds that elicitation any more. */
export async function answerElicitation(
  sessionId: string,
  requestId: string,
  answer: ElicitationAnswer,
): Promise<boolean> {
  if (resolveElicitation(sessionId, requestId, answer).found) return true

  const pending = codexAppServer
    .listPendingElicitations(sessionId)
    .find((candidate) => String(candidate.requestId) === requestId)
  if (!pending) return false
  try {
    await codexAppServer.respondElicitation(pending.requestId, answer)
  } catch (error) {
    throw new AgentRuntimeError(
      502,
      "CODEX_ELICITATION_FAILED",
      error instanceof Error ? error.message : "Failed to answer Codex elicitation request",
    )
  }
  return true
}
