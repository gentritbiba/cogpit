import { ErrorCodes, RouteError, sendError } from "../lib/routeError"
import { sendToSession } from "../lib/sessionSend"
import { sendAgentError } from "./agentErrors"
import {
  HttpBodyError,
  MAX_REQUEST_BODY_BYTES,
  readJsonBody,
  sendJson,
  type UseFn,
} from "../http"
import type { SendRequest } from "../agents/runtimes"

/**
 * POST /api/send-message — deliver a message to an existing session.
 *
 * The agent is resolved once, up front, and everything after that is the same
 * three lines for all three: the runtime decides whether the message joins a
 * running turn or opens a new one, and whether the response can be sent now or
 * has to wait for the turn.
 */
export function registerSessionSendRoutes(use: UseFn) {
  use("/api/send-message", (req, res, next) => {
    if (req.method !== "POST") return next()

    void (async () => {
      let request: SendRequest
      let sessionId: string
      let parsed: Partial<SendRequest> & { sessionId?: string }
      try {
        parsed = await readJsonBody<Partial<SendRequest> & { sessionId?: string }>(req, {
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

      try {
        const { runtime, outcome } = await sendToSession(sessionId, request)

        // A resume reports the turn's outcome on this request and nowhere else,
        // so the response stays open until it settles and carries the agent's
        // own error text. Agents that report completion through the transcript
        // return no promise and answer immediately.
        if (outcome.completion) {
          const result = await outcome.completion
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
      } catch (error) {
        if (error instanceof RouteError) {
          sendError(res, error)
          return
        }
        sendAgentError(res, error, "The agent failed to accept the message")
      }
    })().catch((error: unknown) => {
      if (!res.headersSent) sendAgentError(res, error, "Request failed")
    })
  })
}
