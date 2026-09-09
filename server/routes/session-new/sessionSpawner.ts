import { isAbsolute } from "node:path"
import type { ServerResponse } from "node:http"
import {
  agentKindForDirName,
  descriptorFor,
} from "../../../shared/session/agent-descriptors"
import type { AgentKind } from "../../../shared/session/agent-descriptors"
import { runtimeFor } from "../../agents/runtimes"
import type { ImageAttachment, StartSessionRequest } from "../../agents/runtimes"
import { dirs, isWithinDir, join } from "../../helpers"
import { MAX_REQUEST_BODY_BYTES, sendJson, withJsonBody, type UseFn } from "../../http"
import { ErrorCodes, RouteError, sendError } from "../../lib/routeError"
import { sendAgentError } from "../agentErrors"
import { getDataRoot } from "../../config"
import { getRequestPrincipal } from "../../team/requestPrincipal"
import { resolveProjectCwd } from "../../lib/projectCwd"
import { SessionCreationRequests } from "../../lib/sessionCreationRequests"

const creationRequests = new SessionCreationRequests(() => join(getDataRoot(), "session-creation-requests"))

/**
 * The session-creation route, for every agent.
 *
 * All the per-agent work — which transport creates the session, how its
 * transcript is named and found, how a failed create is rolled back — lives
 * behind `AgentRuntime.start`. What is left here is the part that is genuinely
 * the route's: validating the request, deciding the working directory, and
 * shaping the response.
 */

/** Payload the session-spawn route accepts. */
interface NewSessionBody {
  requestId?: string
  dirName?: string
  cwd?: string
  message?: string
  images?: ImageAttachment[]
  permissions?: StartSessionRequest["permissions"]
  model?: string
  effort?: string
  fastMode?: boolean
  ultracode?: boolean
  worktreeName?: string
  mcpConfig?: string | null
  name?: string
}

function isUsablePath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value)
}

/**
 * The absolute directory a new session runs in.
 *
 * Two shapes of dirName meet here. Most agents encode the project path itself,
 * so decoding is exact and the only question is whether the result is usable.
 * Claude's encoding is lossy, so the path is either read back out of a
 * transcript already in the directory or supplied by the caller — and a
 * caller-supplied one is only trusted when it re-encodes to the same dirName,
 * which is what stops one project's request from writing into another's.
 */
async function resolveSpawnCwd(
  kind: AgentKind,
  dirName: string,
  requestedCwd: string | undefined,
): Promise<string | RouteError> {
  const descriptor = descriptorFor(kind)
  if (!descriptor.dirName.lossy) {
    const cwd = descriptor.dirName.decode(dirName)
    return isUsablePath(cwd)
      ? cwd
      : new RouteError(
          400,
          ErrorCodes.INVALID_REQUEST,
          `Invalid ${descriptor.displayName} project`,
        )
  }

  const projectDir = join(dirs.PROJECTS_DIR, dirName)
  if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
    return new RouteError(403, ErrorCodes.FORBIDDEN, "Access denied")
  }
  if (requestedCwd === undefined) return await resolveProjectCwd(projectDir, dirName) ?? projectDir
  if (!isUsablePath(requestedCwd)) {
    return new RouteError(
      400,
      ErrorCodes.INVALID_REQUEST,
      "cwd must be a non-NUL absolute path",
    )
  }
  if (descriptor.dirName.encode(requestedCwd) !== dirName) {
    return new RouteError(400, ErrorCodes.INVALID_REQUEST, "cwd does not match dirName")
  }
  return requestedCwd
}

/** Run a spawn and answer with the created session. */
async function respondWithSession(
  res: ServerResponse,
  dirName: string,
  requestedCwd: string | undefined,
  request: Omit<StartSessionRequest, "dirName" | "cwd">,
  retry?: { requestId: string; scope: string },
): Promise<void> {
  const kind = agentKindForDirName(dirName)
  const cwd = await resolveSpawnCwd(kind, dirName, requestedCwd)
  if (cwd instanceof RouteError) {
    sendError(res, cwd)
    return
  }

  const runtime = runtimeFor(kind)
  try {
    const startRequest = { ...request, dirName, cwd }
    const start = () => runtime.start(startRequest)
    const started = retry
      ? await creationRequests.run(retry.scope, retry.requestId, startRequest, start)
      : await start()
    sendJson(res, 200, {
      success: true,
      ...(retry ? { requestId: retry.requestId } : {}),
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
    sendAgentError(
      res,
      error,
      `Failed to start ${runtime.descriptor.displayName} session`,
    )
  }
}

export function registerCreateAndSendRoute(use: UseFn) {
  use("/api/create-and-send", (req, res, next) => {
    if (req.method !== "POST") return next()

    withJsonBody<NewSessionBody>(req, res, async (body) => {
      const {
        requestId, dirName, cwd, message, images, permissions,
        model, effort, fastMode, ultracode, worktreeName, mcpConfig, name,
      } = body
      if (!dirName || (!message && (!images || !images.length))) {
        sendError(res, new RouteError(
          400,
          ErrorCodes.INVALID_REQUEST,
          "dirName and message (or images) are required",
        ))
        return
      }
      await respondWithSession(res, dirName, cwd, {
        message,
        images,
        permissions,
        model,
        effort,
        fastMode,
        ultracode,
        worktreeName,
        mcpConfig,
        name,
      }, requestId === undefined ? undefined : {
        requestId,
        scope: getRequestPrincipal(req)?.userId ?? "local",
      })
    }, { maxBytes: MAX_REQUEST_BODY_BYTES })
  })
}
