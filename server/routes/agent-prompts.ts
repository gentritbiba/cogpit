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
import type {
  ElicitationAction,
  ElicitationContent,
  MissionControlElicitation,
  MissionControlUserDialog,
  UserDialogChoice,
} from "../../shared/contracts/agentPrompts"

const ELICITATION_ACTIONS = new Set<ElicitationAction>(["accept", "decline", "cancel"])
const DIALOG_CHOICES = new Set<UserDialogChoice>(["retry_fallback", "edit_prompt", "cancelled"])

export function registerAgentPromptRoutes(use: UseFn) {
  /**
   * GET /api/agent-prompts — everything blocking a session that is not a tool
   * call: MCP elicitations and CLI user dialogs, grouped by session.
   *
   * One endpoint for both because the dashboard polls them on the same tick,
   * and both are read from the live resolver maps rather than from transcripts:
   * neither ever reaches a JSONL, and being listed here proves the prompt is
   * still answerable rather than a leftover from a dead worker.
   */
  use("/api/agent-prompts", (req, res, next) => {
    if (req.method !== "GET") {
      next()
      return
    }
    const elicitationsBySession: Record<string, MissionControlElicitation[]> = {}
    const dialogsBySession: Record<string, MissionControlUserDialog[]> = {}
    for (const sessionId of listAgentPromptSessionIds()) {
      const elicitations = getSDKElicitations(sessionId)
      if (elicitations.length > 0) elicitationsBySession[sessionId] = elicitations
      const dialogs = getSDKUserDialogs(sessionId)
      if (dialogs.length > 0) dialogsBySession[sessionId] = dialogs
    }
    sendJson(res, 200, { elicitationsBySession, dialogsBySession })
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
    }>(req, res, (parsed) => {
      const { sessionId, requestId, action, content } = parsed

      if (!sessionId || typeof sessionId !== "string") {
        sendJson(res, 400, { error: "sessionId is required" })
        return
      }
      if (!requestId || typeof requestId !== "string") {
        sendJson(res, 400, { error: "requestId is required" })
        return
      }
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

      if (!sdkSessions.has(sessionId)) {
        sendJson(res, 404, { error: "Session not found or not a live SDK session" })
        return
      }

      const result = resolveElicitation(sessionId, requestId, {
        action: action as ElicitationAction,
        ...(parsedContent ? { content: parsedContent } : {}),
      })
      if (!result.found) {
        sendJson(res, 404, { error: "Elicitation not found or already answered" })
        return
      }

      sendJson(res, 200, { ok: true })
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
    }>(req, res, (parsed) => {
      const { sessionId, requestId, choice } = parsed

      if (!sessionId || typeof sessionId !== "string") {
        sendJson(res, 400, { error: "sessionId is required" })
        return
      }
      if (!requestId || typeof requestId !== "string") {
        sendJson(res, 400, { error: "requestId is required" })
        return
      }
      if (typeof choice !== "string" || !DIALOG_CHOICES.has(choice as UserDialogChoice)) {
        sendJson(res, 400, { error: "choice must be retry_fallback, edit_prompt or cancelled" })
        return
      }

      if (!sdkSessions.has(sessionId)) {
        sendJson(res, 404, { error: "Session not found or not a live SDK session" })
        return
      }

      const result = resolveUserDialog(sessionId, requestId, choice as UserDialogChoice)
      if (!result.found) {
        sendJson(res, 404, { error: "Dialog not found or already answered" })
        return
      }

      sendJson(res, 200, { ok: true })
    })
  })
}
