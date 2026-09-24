import { parseSettingsChange, type SessionSettingField } from "../../shared/contracts/sessionSettings"
import { ErrorCodes, RouteError, sendError } from "../lib/routeError"
import { setSessionsArchived } from "../lib/sessionArchive"
import { settleTurnSettings } from "../lib/sessionSettings"
import { resolveSessionAgent, runtimeFor } from "../agents/runtimes"
import { authorizeSession, sendTurn } from "../edition"
import { sendAgentError } from "./agentErrors"
import { imagesRefusal } from "./imageAttachments"
import {
  HttpBodyError,
  MAX_REQUEST_BODY_BYTES,
  readJsonBody,
  sendJson,
  type UseFn,
} from "../http"
import type { SendOutcome, SendRequest, TurnResult } from "../agents/runtimes"

type SendBody = Partial<SendRequest> & { sessionId?: string; settingsChange?: unknown }

/**
 * POST /api/send-message — deliver a message to an existing session.
 *
 * The agent is resolved once, up front, and everything after that is the same
 * three lines for all three: the runtime decides whether the message joins a
 * running turn or opens a new one, and whether the response can be sent now or
 * has to wait for the turn. A body without a permission mode runs in the
 * session's stored one. The edition may hold the rest to the stored settings
 * too, except the ones the body lists in `settingsChange`.
 */
export function registerSessionSendRoutes(use: UseFn) {
  use("/api/send-message", (req, res, next) => {
    if (req.method !== "POST") return next()

    void (async () => {
      let request: SendRequest
      let sessionId: string
      let settingsChange: SessionSettingField[]
      let parsed: SendBody
      try {
        parsed = await readJsonBody<SendBody>(req, {
          maxBytes: MAX_REQUEST_BODY_BYTES,
        })
        sessionId = parsed.sessionId as string
        if (!sessionId || (!parsed.message && (!parsed.images || parsed.images.length === 0))) {
          sendError(res, new RouteError(
            400,
            ErrorCodes.INVALID_REQUEST,
            "sessionId and message or images are required",
          ))
          return
        }
        const refusal = imagesRefusal(parsed.images)
        if (refusal) {
          sendError(res, refusal)
          return
        }
        const named = parseSettingsChange(parsed.settingsChange)
        if (!named) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "settingsChange must list session settings"))
          return
        }
        settingsChange = named
        request = {
          message: parsed.message,
          images: parsed.images,
          cwd: parsed.cwd,
          permissions: parsed.permissions,
          model: parsed.model,
          effort: parsed.effort,
          contextWindowTokens: parsed.contextWindowTokens,
          fastMode: parsed.fastMode,
          ultracode: parsed.ultracode,
          mcpConfig: parsed.mcpConfig,
        }
      } catch (error) {
        if (error instanceof HttpBodyError && error.statusCode === 413) {
          sendJson(res, error.statusCode, { error: error.message })
          return
        }
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
        return
      }
      const receivedAt = Date.now()

      const authorized = await authorizeSession(req, res, { sessionId }, "interact")
      if (authorized === null) return

      const { kind, filePath } = await resolveSessionAgent(sessionId)
      const runtime = runtimeFor(kind)
      const failure = `${runtime.descriptor.displayName} failed to accept the message`
      const session = { sessionId: authorized.sessionId, agent: kind }
      let outcome: SendOutcome
      try {
        const settled = await settleTurnSettings(req, session, { ...request, filePath }, settingsChange)
        outcome = await sendTurn(req, runtime, sessionId, settled, {
          receivedAt,
          route: "send-message",
          session,
        })
      } catch (error) {
        sendAgentError(res, error, failure)
        return
      }
      if (outcome.delivery === "busy") {
        sendError(res, new RouteError(409, ErrorCodes.CONFLICT, "Session is already active"))
        return
      }
      // A message to an archived session resumes it, and a resumed session
      // belongs back in the sidebar right away.
      setSessionsArchived([sessionId], false).catch(() => {})

      // A resume reports the turn's outcome on this request and nowhere else,
      // so the response stays open until it settles and carries the agent's
      // own error text. Agents that report completion through the transcript
      // return no promise and answer immediately.
      if (outcome.completion) {
        let result: TurnResult
        try {
          result = await outcome.completion
        } catch (error) {
          sendAgentError(res, error, failure)
          return
        }
        if (result.isError) {
          sendError(res, new RouteError(
            500,
            ErrorCodes.INTERNAL_ERROR,
            result.message || `${runtime.descriptor.displayName} returned an error`,
          ))
          return
        }
      }

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ success: true }))
    })().catch((error: unknown) => {
      if (!res.headersSent) sendAgentError(res, error, "Request failed")
    })
  })
}
