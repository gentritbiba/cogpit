import { agentKindForDirName } from "../../shared/session/agent-descriptors"
import {
  allRuntimes,
  resolveSessionAgent,
  runtimeFor,
} from "../agents/runtimes"
import { storeForPath } from "../agents"
import { resolveSessionFilePath } from "../sessionPaths"
import type { IncomingMessage, ServerResponse } from "node:http"
import { HttpBodyError, readJsonBody, sendJson, type UseFn } from "../http"
import {
  activeProcesses,
  killTrackedProcesses,
  persistentSessions,
} from "../processRegistry"
import {
  updateSDKSession,
  rewindClaudeFiles,
  stopSDKTask,
  backgroundSDKTasks,
  type SDKSessionUpdates,
} from "../sdk-session"
import { RouteError, sendError, ErrorCodes } from "../lib/routeError"
import { listShares, removeShare } from "../share/registry"
import { revokeShareTokensForSession } from "../security"
import { registerRunningProcessesRoute } from "./session-manage/processInventory"
import { sendAgentError } from "./agentErrors"

/**
 * Session lifecycle: interrupt, stop, kill-all, delete, and the process
 * inventory behind them.
 *
 * Every route here resolves the session's agent once and then talks to one
 * `AgentRuntime`. That is a behaviour fix as much as a tidy-up: interrupt and
 * stop used to identify Codex by "does it have a turn running right now", so an
 * idle Codex session fell through to the Claude SDK, which silently did
 * nothing about a session it had never heard of.
 */

function handleJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  handleBody: (body: T) => void | Promise<void>,
  handleReadError: (error: unknown) => void,
  options: { allowEmpty?: boolean } = {},
): void {
  void (async () => {
    let body: T
    try {
      body = await readJsonBody<T>(req, options)
    } catch (error) {
      if (error instanceof HttpBodyError && error.statusCode === 413) {
        sendJson(res, error.statusCode, { error: error.message })
      } else {
        handleReadError(error)
      }
      return
    }

    try {
      await handleBody(body)
    } catch (error) {
      if (!res.headersSent) sendAgentError(res, error, "Request failed")
    }
  })()
}

function sendInvalidSettingsPayload(res: ServerResponse): void {
  sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid Claude settings payload"))
}

function sendCheckpointError(res: ServerResponse, error: unknown): void {
  sendError(res, new RouteError(
    502,
    ErrorCodes.INTERNAL_ERROR,
    error instanceof Error ? error.message : "Claude checkpoint rewind failed",
  ))
}

/** Matched on the file too: a Codex rollout file name is not the session id. */
function sharedSessionIdsFor(sessionId: string, dirName: string, fileName: string): string[] {
  return listShares()
    .filter((share) => (
      share.sessionId === sessionId
      || (share.dirName === dirName && share.fileName === fileName)
    ))
    .map((share) => share.sessionId)
}

export function registerSessionManageRoutes(use: UseFn) {
  use("/api/claude/settings", (req, res, next) => {
    if (req.method !== "POST") return next()
    const match = (req.url ?? "").match(/^\/([^/?]+)$/)
    if (!match) return next()
    const sessionId = decodeURIComponent(match[1])
    handleJsonBody<SDKSessionUpdates>(req, res, async (updates) => {
      try {
        const result = await updateSDKSession(sessionId, updates)
        sendJson(res, 200, { success: true, ...result })
      } catch {
        sendInvalidSettingsPayload(res)
      }
    }, () => {
      sendInvalidSettingsPayload(res)
    })
  })

  use("/api/interrupt-session", (req, res, next) => {
    if (req.method !== "POST") return next()
    handleJsonBody<unknown>(req, res, async (body) => {
      let sessionId: string
      try {
        sessionId = (body as { sessionId: string }).sessionId
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
        return
      }
      if (!sessionId) {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId is required"))
        return
      }
      const { kind } = await resolveSessionAgent(sessionId)
      sendJson(res, 200, { success: await runtimeFor(kind).interrupt(sessionId) })
    }, () => {
      sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
    })
  })

  use("/api/claude/checkpoints", (req, res, next) => {
    if (req.method !== "POST") return next()
    const match = (req.url ?? "").match(/^\/([^/?]+)\/rewind$/)
    if (!match) return next()
    const sessionId = decodeURIComponent(match[1])
    handleJsonBody<unknown>(req, res, async (body) => {
      try {
        const { userMessageId, cwd, dryRun } = body as Record<string, unknown>
        if (typeof userMessageId !== "string" || typeof cwd !== "string") {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "userMessageId and cwd are required"))
          return
        }
        const result = await rewindClaudeFiles(sessionId, userMessageId, cwd, dryRun === true)
        sendJson(res, 200, result)
      } catch (error) {
        sendCheckpointError(res, error)
      }
    }, (error) => {
      sendCheckpointError(res, error)
    })
  })

  use("/api/claude/tasks", (req, res, next) => {
    const path = req.url ?? ""
    const stopMatch = path.match(/^\/([^/?]+)\/([^/?]+)$/)
    const backgroundMatch = path.match(/^\/([^/?]+)\/background$/)
    if (req.method === "DELETE" && stopMatch) {
      void stopSDKTask(
        decodeURIComponent(stopMatch[1]),
        decodeURIComponent(stopMatch[2]),
      ).then((stopped) => {
        sendJson(res, 200, { success: stopped })
      }, (error) => {
        sendError(res, new RouteError(502, ErrorCodes.INTERNAL_ERROR, String(error)))
      })
      return
    }
    if (req.method === "POST" && backgroundMatch) {
      handleJsonBody<unknown>(req, res, async (body) => {
        let toolUseId: string | undefined
        try {
          const parsed = body as { toolUseId?: unknown }
          toolUseId = typeof parsed.toolUseId === "string" ? parsed.toolUseId : undefined
        } catch {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
          return
        }
        const backgrounded = await backgroundSDKTasks(decodeURIComponent(backgroundMatch[1]), toolUseId)
        sendJson(res, 200, { success: backgrounded })
      }, () => {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
      }, { allowEmpty: true })
      return
    }
    next()
  })

  use("/api/stop-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    handleJsonBody<unknown>(req, res, async (body) => {
      let sessionId: string
      try {
        sessionId = (body as { sessionId: string }).sessionId
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
        return
      }
      if (!sessionId) {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId is required"))
        return
      }

      const { kind } = await resolveSessionAgent(sessionId)
      const stopped = await runtimeFor(kind).stop(sessionId)
      sendJson(res, 200, stopped
        ? { success: true }
        : { success: false, error: "No active process for this session" })
    }, () => {
      sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
    })
  })

  use("/api/kill-all", (req, res, next) => {
    if (req.method !== "POST") return next()

    // Each runtime stops its own work at its own granularity: Codex interrupts
    // turns and keeps the threads, Copilot destroys sessions, Claude closes its
    // queries. Those are not interchangeable, so none of them is flattened into
    // the others — only the counts are summed.
    void Promise.all(allRuntimes().map((runtime) => runtime.stopAll()))
      .then((results) => {
        const failed = results.reduce((total, result) => total + result.failed, 0)
        const stopped = results.reduce((total, result) => total + result.stopped, 0)
        sendJson(res, 200, {
          success: failed === 0,
          killed: stopped + killTrackedProcesses(),
          ...(failed > 0 ? { nativeInterruptFailures: failed } : {}),
        })
      })
      .catch((error: unknown) => {
        if (!res.headersSent) sendAgentError(res, error, "Failed to stop running agents")
      })
  })

  registerRunningProcessesRoute(use)

  use("/api/kill-process", (req, res, next) => {
    if (req.method !== "POST") return next()

    handleJsonBody<unknown>(req, res, (body) => {
      try {
        const { pid } = body as Record<string, unknown>
        if (!pid || typeof pid !== "number" || pid < 2) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Valid pid required"))
          return
        }

        let isTracked = false

        for (const [sid, ps] of persistentSessions) {
          if (ps.proc.pid === pid) {
            isTracked = true
            ps.dead = true
            persistentSessions.delete(sid)
            break
          }
        }
        if (!isTracked) {
          for (const [sid, proc] of activeProcesses) {
            if (proc.pid === pid) {
              isTracked = true
              activeProcesses.delete(sid)
              break
            }
          }
        }

        if (!isTracked) {
          sendError(res, new RouteError(403, ErrorCodes.FORBIDDEN, "Can only kill tracked agent processes"))
          return
        }

        try {
          process.kill(pid, "SIGTERM")
          const forceKill = setTimeout(() => {
            try { process.kill(pid, "SIGKILL") } catch { /* already dead */ }
          }, 3000)
          forceKill.unref()

          sendJson(res, 200, { success: true, pid })
        } catch {
          sendError(res, new RouteError(404, ErrorCodes.NOT_FOUND, "Process not found or already dead"))
        }
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
      }
    }, () => {
      sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
    })
  })

  use("/api/delete-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    handleJsonBody<unknown>(req, res, async (body) => {
      try {
        const parsed = body as Record<string, unknown>
        const dirName = parsed.dirName as string
        const fileName = parsed.fileName as string

        if (!dirName || !fileName) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "dirName and fileName are required"))
          return
        }

        const filePath = await resolveSessionFilePath(dirName, fileName)
        const agentKind = agentKindForDirName(dirName)
        if (!filePath || storeForPath(filePath)?.kind !== agentKind) {
          sendError(res, new RouteError(403, ErrorCodes.FORBIDDEN, "Access denied"))
          return
        }

        const runtime = runtimeFor(agentKind)
        // The id a URL carries for this transcript: the bare uuid for agents
        // whose file name rebuilds from it, the relative path for the rest.
        const sessionId = runtime.descriptor.sessionFile.urlId(fileName)
        await runtime.deleteSession(sessionId, filePath)

        // A share left behind would hand its guest whatever session next
        // claims this id.
        for (const sharedId of sharedSessionIdsFor(sessionId, dirName, fileName)) {
          await removeShare(sharedId)
          revokeShareTokensForSession(sharedId)
        }

        sendJson(res, 200, { success: true })
      } catch (err) {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : "Failed to delete session"))
      }
    }, (error) => {
      sendError(res, new RouteError(
        400,
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : "Failed to delete session",
      ))
    })
  })
}
