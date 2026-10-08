import type { IncomingMessage, ServerResponse } from "node:http"
import { AGENT_KINDS, type AgentKind } from "../../../shared/session/agent-descriptors"
import type { ImageAttachment, StartSessionRequest } from "../../agents/runtimes"
import { MAX_REQUEST_BODY_BYTES, sendJson, withJsonBody, type UseFn } from "../../http"
import { ErrorCodes, RouteError, sendError } from "../../lib/routeError"
import { createSession, type CreateSessionInput } from "../../lib/sessionCreate"
import { authorizeSession, getRequestPrincipal, markDecided, startTurn } from "../../edition"
import { commandScope } from "../../lib/durableSend"
import { orchestrationStore } from "../../orchestration/storage"
import { resumeDelegations } from "../../lib/delegationAuthority"
import { sendAgentError } from "../agentErrors"
import { imagesRefusal } from "../imageAttachments"

/**
 * The session-creation route, for every agent: validating the request and
 * shaping the response around `createSession`.
 */

/** Payload the session-spawn route accepts. */
interface NewSessionBody {
  requestId?: string
  dirName?: string
  cwd?: string
  instanceId?: string
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

/** Run a spawn on the caller's behalf and answer with the created session. */
async function respondWithSession(
  req: IncomingMessage,
  res: ServerResponse,
  receivedAt: number,
  input: CreateSessionInput,
): Promise<void> {
  try {
    const started = await createSession(input, (runtime, request) => startTurn(req, receivedAt, runtime, request))
    if (input.parentSessionId) {
      orchestrationStore().putTask(commandScope(req), { parentSessionId: input.parentSessionId, childSessionId: started.sessionId, sourceId: input.retry?.requestId || started.sessionId })
      resumeDelegations(req, input.parentSessionId)
    }
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
      const receivedAt = Date.now()
      const {
        requestId, dirName, cwd, agent, instanceId, parentSessionId, message, images, permissions,
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
      const refusal = imagesRefusal(images)
      if (refusal) {
        sendError(res, refusal)
        return
      }
      // A new session names no session the caller could lack access to.
      if (parentSessionId && await authorizeSession(req, res, { sessionId: parentSessionId }, "interact") === null) return
      markDecided(req)
      await respondWithSession(req, res, receivedAt, {
        dirName,
        cwd,
        agent,
        instanceId,
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
