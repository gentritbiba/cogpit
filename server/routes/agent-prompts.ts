import type { IncomingMessage, ServerResponse } from "node:http"
import {
  sdkSessions,
  resolveElicitation,
  resolveUserDialog,
  getSDKElicitations,
  getSDKUserDialogs,
  listAgentPromptSessionIds,
  normalizeElicitationContent,
} from "../sdk-session"
import { sendJson, type UseFn, withJsonBody } from "../http"
import { runtimeForSession } from "../agents/runtimes"
import { authorizeSession, reportSessionEvent, type ActivityData } from "../edition"
import type {
  ElicitationAction,
  ElicitationContent,
  UserDialogChoice,
} from "../../shared/contracts/agentPrompts"
import { visibleBySession } from "./visibleBySession"

const ELICITATION_ACTIONS = new Set<ElicitationAction>(["accept", "decline", "cancel"])
const DIALOG_CHOICES = new Set<UserDialogChoice>(["retry_fallback", "edit_prompt", "cancelled"])

/** The prompt an answer is for. */
interface PromptTarget {
  sessionId: string
  requestId: string
}

/** The prompt a body names; null after answering 400. */
function promptTarget(res: ServerResponse, body: { sessionId?: unknown; requestId?: unknown }): PromptTarget | null {
  const { sessionId, requestId } = body
  if (!sessionId || typeof sessionId !== "string") {
    sendJson(res, 400, { error: "sessionId is required" })
    return null
  }
  if (!requestId || typeof requestId !== "string") {
    sendJson(res, 400, { error: "requestId is required" })
    return null
  }
  return { sessionId, requestId }
}

/**
 * Answer a prompt blocking a live SDK session once the caller may interact
 * with it, and report the answer. `resolve` reports whether the prompt was still
 * waiting.
 */
async function answerPrompt(
  req: IncomingMessage,
  res: ServerResponse,
  { sessionId, requestId }: PromptTarget,
  resolve: (sessionId: string, requestId: string) => { found: boolean },
  notFound: string,
  answer: ActivityData,
): Promise<void> {
  const authorized = await authorizeSession(req, res, { sessionId }, "interact")
  if (authorized === null) return
  const runtime = sdkSessions.has(sessionId) ? runtimeForSession(sessionId) : null
  if (!runtime) {
    sendJson(res, 404, { error: "Session not found or not a live SDK session" })
    return
  }
  if (!resolve(sessionId, requestId).found) {
    sendJson(res, 404, { error: notFound })
    return
  }
  reportSessionEvent(req, "session.answer", { sessionId: authorized.sessionId, agent: runtime.kind }, { requestId, ...answer })
  sendJson(res, 200, { ok: true })
}

export function registerAgentPromptRoutes(use: UseFn) {
  /**
   * GET /api/agent-prompts — everything blocking a session the caller may see
   * that is not a tool call: MCP elicitations and CLI user dialogs, grouped by
   * session.
   *
   * One endpoint for both because the dashboard polls them on the same tick,
   * and both are read from the live resolver maps rather than from transcripts:
   * neither ever reaches a JSONL, and being listed here proves the prompt is
   * still answerable rather than a leftover from a dead worker.
   */
  use("/api/agent-prompts", async (req, res, next) => {
    if (req.method !== "GET") {
      next()
      return
    }
    const sessionIds = listAgentPromptSessionIds()
    sendJson(res, 200, {
      elicitationsBySession: await visibleBySession(req, sessionIds.flatMap((sessionId) => getSDKElicitations(sessionId))),
      dialogsBySession: await visibleBySession(req, sessionIds.flatMap((sessionId) => getSDKUserDialogs(sessionId))),
    })
  })

  use("/api/elicitation-answer", (req, res, next) => {
    if (req.method !== "POST") {
      next()
      return
    }

    withJsonBody<{
      sessionId?: unknown
      requestId?: unknown
      action?: unknown
      content?: unknown
    }>(req, res, async (parsed) => {
      const target = promptTarget(res, parsed)
      if (!target) return
      const { action, content } = parsed
      if (typeof action !== "string" || !ELICITATION_ACTIONS.has(action as ElicitationAction)) {
        sendJson(res, 400, { error: "action must be accept, decline or cancel" })
        return
      }

      let parsedContent: ElicitationContent | undefined
      if (content !== undefined && content !== null) {
        const normalized = normalizeElicitationContent(content)
        if (!normalized) {
          sendJson(res, 400, {
            error: "content must be an object of strings, numbers, booleans or string arrays",
          })
          return
        }
        parsedContent = normalized
      }

      const answer = {
        action: action as ElicitationAction,
        ...(parsedContent ? { content: parsedContent } : {}),
      }
      await answerPrompt(
        req,
        res,
        target,
        (sessionId, requestId) => resolveElicitation(sessionId, requestId, answer),
        "Elicitation not found or already answered",
        answer,
      )
    })
  })

  use("/api/user-dialog-answer", (req, res, next) => {
    if (req.method !== "POST") {
      next()
      return
    }

    withJsonBody<{
      sessionId?: unknown
      requestId?: unknown
      choice?: unknown
    }>(req, res, async (parsed) => {
      const target = promptTarget(res, parsed)
      if (!target) return
      const { choice } = parsed
      if (typeof choice !== "string" || !DIALOG_CHOICES.has(choice as UserDialogChoice)) {
        sendJson(res, 400, { error: "choice must be retry_fallback, edit_prompt or cancelled" })
        return
      }

      await answerPrompt(
        req,
        res,
        target,
        (sessionId, requestId) => resolveUserDialog(sessionId, requestId, choice as UserDialogChoice),
        "Dialog not found or already answered",
        { choice },
      )
    })
  })
}
