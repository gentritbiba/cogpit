import { isAbsolute } from "node:path"
import type { ServerResponse } from "node:http"
import {
  AGENT_KINDS,
  agentKindForDirName,
  descriptorFor,
  projectDirNameFor,
} from "../../../shared/session/agent-descriptors"
import type { AgentKind } from "../../../shared/session/agent-descriptors"
import { runtimeFor } from "../../agents/runtimes"
import type { ImageAttachment, StartSessionRequest, StartedSession } from "../../agents/runtimes"
import { dirs, isWithinDir, join } from "../../helpers"
import { MAX_REQUEST_BODY_BYTES, sendJson, withJsonBody, type UseFn } from "../../http"
import { ErrorCodes, RouteError, sendError } from "../../lib/routeError"
import { sendAgentError } from "../agentErrors"
import { getDataRoot } from "../../config"
import { getRequestPrincipal } from "../../team/requestPrincipal"
import { resolveProjectCwd } from "../../lib/projectCwd"
import { SessionCreationRequests } from "../../lib/sessionCreationRequests"
import { recordSessionParent } from "../../lib/sessionLineage"

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

export interface CreateSessionInput extends Omit<StartSessionRequest, "dirName" | "cwd"> {
  /** The project to create the session under; derived from `cwd` when absent. */
  dirName?: string
  cwd?: string
  /** Which agent runs a session created from `cwd` alone. */
  agent?: AgentKind
  /** The session that asked for this one, recorded so it can find its children. */
  parentSessionId?: string
  retry?: { requestId: string; scope: string }
}

/**
 * Create a session for the HTTP route and the session CLI alike. Throws a
 * `RouteError` for a request that cannot name a usable project.
 */
export async function createSession(input: CreateSessionInput): Promise<StartedSession> {
  const { dirName: requestedDirName, cwd: requestedCwd, agent, parentSessionId, retry, ...request } = input
  if (!requestedDirName && !isUsablePath(requestedCwd)) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "dirName or an absolute cwd is required")
  }
  const dirName = requestedDirName
    ?? projectDirNameFor(agent ?? agentKindForDirName(undefined), requestedCwd as string)
  const kind = agentKindForDirName(dirName)
  const cwd = await resolveSpawnCwd(kind, dirName, requestedCwd)
  if (cwd instanceof RouteError) throw cwd

  const runtime = runtimeFor(kind)
  const startRequest = { ...request, dirName, cwd }
  const start = () => runtime.start(startRequest)
  const started = retry
    ? await creationRequests.run(retry.scope, retry.requestId, startRequest, start)
    : await start()
  if (parentSessionId) await recordSessionParent(started.sessionId, parentSessionId)
  return started
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
