import { isAbsolute } from "node:path"
import {
  agentKindForDirName,
  descriptorFor,
  projectDirNameFor,
  type AgentKind,
} from "../../shared/session/agent-descriptors"
import { runtimeFor } from "../agents/runtimes"
import type { StartSessionRequest, StartedSession } from "../agents/runtimes"
import { getDataRoot } from "../config"
import { dirs, isWithinDir, join } from "../helpers"
import { resolveProjectCwd } from "./projectCwd"
import { ErrorCodes, RouteError } from "./routeError"
import { SessionCreationRequests } from "./sessionCreationRequests"
import { recordSessionOrigin } from "./sessionOrigins"

/**
 * Starting a session, for the create-and-send route and the session CLI alike.
 *
 * All the per-agent work — which transport creates the session, how its
 * transcript is named and found, how a failed create is rolled back — lives
 * behind `AgentRuntime.start`. What is left here is deciding the project and
 * working directory, and making retries of one request start one session.
 */

const creationRequests = new SessionCreationRequests(() => join(getDataRoot(), "session-creation-requests"))

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
  if (parentSessionId) await recordSessionOrigin(started.sessionId, { parentSessionId })
  return started
}
