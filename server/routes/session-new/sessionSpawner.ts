import type { ServerResponse } from "node:http"
import { AGENT_KINDS, type AgentKind } from "../../../shared/session/agent-descriptors"
import type { ImageAttachment, StartSessionRequest } from "../../agents/runtimes"
import { MAX_REQUEST_BODY_BYTES, sendJson, withJsonBody, type UseFn } from "../../http"
import { ErrorCodes, RouteError, sendError } from "../../lib/routeError"
import { createSession, type CreateSessionInput } from "../../lib/sessionCreate"
import { getRequestPrincipal } from "../../team/requestPrincipal"
import { sendAgentError } from "../agentErrors"

/**
 * The session-creation route, for every agent: validating the request and
 * shaping the response around `createSession`.
 */

/** Payload the session-spawn route accepts. */
interface NewSessionBody {
  requestId?: string
  dirName?: string
  cwd?: string
  agent?: AgentKind
  parentSessionId?: string
  message?: string
  images?: ImageAttachment[]
  permissions?: StartSessionRequest["permissions"]
  model?: string
  effort?: string
  contextWindowTokens?: number | null
  fastMode?: boolean
  ultracode?: boolean
  worktreeName?: string
  mcpConfig?: string | null
  name?: string
}

/** Run a spawn and answer with the created session. */
async function respondWithSession(res: ServerResponse, input: CreateSessionInput): Promise<void> {
  try {
    const started = await createSession(input)
    sendJson(res, 200, {
      success: true,
      ...(input.retry ? { requestId: input.retry.requestId } : {}),
      dirName: started.dirName,
      fileName: started.fileName,
      sessionId: started.sessionId,
      ...(started.initialContent !== undefined
        ? { initialContent: started.initialContent }
        : {}),
    })
  } catch (error) {
    if (error instanceof RouteError) {
      sendError(res, error)
      return
    }
    sendAgentError(res, error, "Failed to start the session")
  }
}

export function registerCreateAndSendRoute(use: UseFn) {
  use("/api/create-and-send", (req, res, next) => {
    if (req.method !== "POST") return next()

    withJsonBody<NewSessionBody>(req, res, async (body) => {
      const {
        requestId, dirName, cwd, agent, parentSessionId, message, images, permissions,
        model, effort, contextWindowTokens, fastMode, ultracode, worktreeName, mcpConfig, name,
      } = body
      if (!message && (!images || !images.length)) {
        sendError(res, new RouteError(
          400,
          ErrorCodes.INVALID_REQUEST,
          "message (or images) is required",
        ))
        return
      }
      if (agent !== undefined && !AGENT_KINDS.includes(agent)) {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, `agent must be one of ${AGENT_KINDS.join(", ")}`))
        return
      }
      await respondWithSession(res, {
        dirName,
        cwd,
        agent,
        parentSessionId,
        message,
        images,
        permissions,
        model,
        effort,
        contextWindowTokens,
        fastMode,
        ultracode,
        worktreeName,
        mcpConfig,
        name,
        retry: requestId === undefined ? undefined : {
          requestId,
          scope: getRequestPrincipal(req)?.userId ?? "local",
        },
      })
    }, { maxBytes: MAX_REQUEST_BODY_BYTES })
  })
}
