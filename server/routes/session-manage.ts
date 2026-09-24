import {
  allRuntimes,
  resolveSessionAgent,
  runtimeFor,
  runtimeForSession,
  type AgentRuntime,
} from "../agents/runtimes"
import type { IncomingMessage, ServerResponse } from "node:http"
import { sendJson, type UseFn } from "../http"
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
import { heldLiveUpdate, storeAppliedSettings } from "../lib/sessionSettings"
import { parseSettingsChange } from "../../shared/contracts/sessionSettings"
import {
  authorizeSession,
  reportSessionEvent,
  type ActivitySessionRef,
} from "../edition"
import { registerDeleteSessionRoute } from "./session-manage/deleteSession"
import { handleJsonBody } from "./session-manage/jsonBody"
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

function sessionIdFrom(res: ServerResponse, body: unknown): string | null {
  const id = (body as { sessionId?: unknown } | null)?.sessionId
  if (typeof id !== "string" || !id) {
    sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId is required"))
    return null
  }
  return id
}

interface InteractiveSession {
  sessionId: string
  runtime: AgentRuntime
  /** The session as its audit events name it. */
  audit: ActivitySessionRef
}

/** The session a body names and the runtime holding it, once the caller may interact with it; null after answering. */
async function interactiveSession(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<InteractiveSession | null> {
  const sessionId = sessionIdFrom(res, body)
  if (!sessionId) return null
  const authorized = await authorizeSession(req, res, { sessionId }, "interact")
  if (authorized === null) return null
  const { kind } = await resolveSessionAgent(sessionId)
  return { sessionId, runtime: runtimeFor(kind), audit: { sessionId: authorized.sessionId, agent: kind } }
}

export function registerSessionManageRoutes(use: UseFn) {
  use("/api/claude/settings", (req, res, next) => {
    if (req.method !== "POST") return next()
    const match = (req.url ?? "").match(/^\/([^/?]+)$/)
    if (!match) return next()
    const sessionId = decodeURIComponent(match[1])
    handleJsonBody<(SDKSessionUpdates & { settingsChange?: unknown }) | null>(req, res, async (body) => {
      const { settingsChange, ...sent } = body ?? {}
      const changes = body === null ? null : parseSettingsChange(settingsChange)
      if (changes === null) return sendInvalidSettingsPayload(res)
      const authorized = await authorizeSession(req, res, { sessionId }, "interact")
      if (authorized === null) return
      const updates = heldLiveUpdate(sent, changes)
      // Read in the same tick as the update: whenever the update finds the session, its runtime holds it.
      const holder = runtimeForSession(sessionId)
      try {
        const { permissionChange, ...result } = await updateSDKSession(sessionId, updates)
        if (permissionChange && holder) {
          reportSessionEvent(req, "session.permission", { sessionId: authorized.sessionId, agent: holder.kind }, permissionChange)
        }
        const { permissionMode, model, effort, fastMode, ultracode } = updates
        await storeAppliedSettings(req, authorized.sessionId, holder?.kind ?? null, {
          permissions: permissionMode === undefined ? undefined : { mode: permissionMode },
          model,
          effort,
          fastMode,
          ultracode,
        }).catch((error: unknown) => {
          console.error("[session-config] Storing settings applied to a running session failed:", error)
        })
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
      const session = await interactiveSession(req, res, body)
      if (!session) return
      const interrupted = await session.runtime.interrupt(session.sessionId)
      if (interrupted) reportSessionEvent(req, "session.interrupt", session.audit)
      sendJson(res, 200, { success: interrupted })
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
      const sessionId = decodeURIComponent(stopMatch[1])
      const taskId = decodeURIComponent(stopMatch[2])
      void (async () => {
        if (await authorizeSession(req, res, { sessionId }, "interact") === null) return
        sendJson(res, 200, { success: await stopSDKTask(sessionId, taskId) })
      })().catch((error: unknown) => {
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
        const sessionId = decodeURIComponent(backgroundMatch[1])
        if (await authorizeSession(req, res, { sessionId }, "interact") === null) return
        const backgrounded = await backgroundSDKTasks(sessionId, toolUseId)
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
      const session = await interactiveSession(req, res, body)
      if (!session) return

      const stopped = await session.runtime.stop(session.sessionId)
      if (stopped) reportSessionEvent(req, "session.stop", session.audit)
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

  registerDeleteSessionRoute(use)
}
