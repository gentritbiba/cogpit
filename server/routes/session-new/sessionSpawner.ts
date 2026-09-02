import { isAbsolute } from "node:path"
import type { ServerResponse } from "node:http"
import {
  agentKindForDirName,
  descriptorFor,
  descriptorForDirName,
} from "../../../shared/session/agent-descriptors"
import type { AgentKind } from "../../../shared/session/agent-descriptors"
import { runtimeFor } from "../../agents/runtimes"
import type { ImageAttachment, StartSessionRequest } from "../../agents/runtimes"
import { dirs, isWithinDir, join, open, readdir } from "../../helpers"
import { MAX_REQUEST_BODY_BYTES, withJsonBody, type UseFn } from "../../http"
import { ErrorCodes, RouteError, sendError } from "../../lib/routeError"
import { sendAgentError } from "../agentErrors"

/**
 * The two session-creation routes, for every agent.
 *
 * All the per-agent work — which transport creates the session, how its
 * transcript is named and found, how a failed create is rolled back — lives
 * behind `AgentRuntime.start`. What is left here is the part that is genuinely
 * the route's: validating the request, deciding the working directory, and
 * shaping the response.
 */

/** Payload shared by the two session-spawn routes. */
interface NewSessionBody {
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

/**
 * Recover the project path a session should run in.
 *
 * Only an agent whose dirName is a lossy encoding of the cwd needs this: the
 * real path has to be read back out of a transcript already in the directory.
 * The others encode the path itself and decode it exactly.
 */
export async function resolveProjectPath(
  projectDir: string,
  dirName: string
): Promise<string> {
  try {
    const files = await readdir(projectDir)
    for (const f of files.filter((file) => file.endsWith(".jsonl"))) {
      try {
        const fh = await open(join(projectDir, f), "r")
        try {
          const buf = Buffer.alloc(8192)
          const { bytesRead } = await fh.read(buf, 0, 8192, 0)
          const lines = buf.subarray(0, bytesRead).toString("utf-8").split("\n")
          for (const line of lines) {
            if (!line) continue
            try {
              const parsed = JSON.parse(line)
              if (parsed.cwd) {
                return parsed.cwd
              }
            } catch {
              continue
            }
          }
        } finally {
          await fh.close()
        }
      } catch {
        continue
      }
    }
  } catch {
    // projectDir might not exist yet
  }
  return descriptorForDirName(dirName).dirName.decode(dirName) ?? projectDir
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
  if (requestedCwd === undefined) return resolveProjectPath(projectDir, dirName)
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

/**
 * Run a spawn and answer with the created session.
 *
 * `/api/new-session` and `/api/create-and-send` differ only in which fields
 * they accept and whether the first turn is awaited, so they share this tail.
 */
async function respondWithSession(
  res: ServerResponse,
  dirName: string,
  requestedCwd: string | undefined,
  request: Omit<StartSessionRequest, "dirName" | "cwd">,
): Promise<void> {
  const kind = agentKindForDirName(dirName)
  const cwd = await resolveSpawnCwd(kind, dirName, requestedCwd)
  if (cwd instanceof RouteError) {
    sendError(res, cwd)
    return
  }

  const runtime = runtimeFor(kind)
  try {
    const started = await runtime.start({ ...request, dirName, cwd })
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({
      success: true,
      dirName: started.dirName,
      fileName: started.fileName,
      sessionId: started.sessionId,
      ...(started.initialContent !== undefined
        ? { initialContent: started.initialContent }
        : {}),
    }))
  } catch (error) {
    sendAgentError(
      res,
      error,
      `Failed to start ${runtime.descriptor.displayName} session`,
    )
  }
}

export function registerNewSessionRoute(use: UseFn) {
  use("/api/new-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    withJsonBody<NewSessionBody>(req, res, async (body) => {
      const { dirName, message, permissions, model, effort, fastMode, name } = body
      if (!dirName || !message) {
        sendError(res, new RouteError(
          400,
          ErrorCodes.INVALID_REQUEST,
          "dirName and message are required",
        ))
        return
      }
      await respondWithSession(res, dirName, undefined, {
        message,
        permissions,
        model,
        effort,
        fastMode,
        name,
        // A session created here has no follow-up waiting on it, so Claude runs
        // its CLI once and reports only once that run has produced a transcript.
        oneShot: true,
      })
    })
  })
}

export function registerCreateAndSendRoute(use: UseFn) {
  use("/api/create-and-send", (req, res, next) => {
    if (req.method !== "POST") return next()

    withJsonBody<NewSessionBody>(req, res, async (body) => {
      const {
        dirName, cwd, message, images, permissions,
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
      })
    }, { maxBytes: MAX_REQUEST_BODY_BYTES })
  })
}
