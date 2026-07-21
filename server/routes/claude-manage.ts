import {
  activeProcesses,
  persistentSessions,
  dirs,
  isCodexDirName,
  isWithinDir,
  unlink,
  resolveSessionFilePath,
} from "../helpers"
import type { ChildProcess } from "node:child_process"
import type { IncomingMessage } from "node:http"
import { sendJson, type UseFn } from "../http"
import {
  stopSDKSession,
  cleanupAllSDKSessions,
  interruptSDKTurn,
  updateSDKSession,
  rewindClaudeFiles,
  stopSDKTask,
  backgroundSDKTasks,
  type SDKSessionUpdates,
} from "../sdk-session"
import { RouteError, sendError, ErrorCodes } from "../lib/routeError"
import { codexAppServer } from "../codex-app-server"
import { registerRunningProcessesRoute } from "./claude-manage/processInventory"

function collectRequestBody(
  req: IncomingMessage,
  handleBody: (body: string) => void | Promise<void>,
): void {
  let body = ""
  req.on("data", (chunk: Buffer | string) => { body += chunk.toString() })
  req.on("end", () => { void handleBody(body) })
}

function terminatePersistentSession(sessionId: string): boolean {
  const session = persistentSessions.get(sessionId)
  if (!session) return false
  if (session.dead) return true

  session.dead = true
  session.proc.kill("SIGTERM")
  persistentSessions.delete(sessionId)
  const forceKill = setTimeout(() => {
    try { session.proc.kill("SIGKILL") } catch { /* already dead */ }
  }, 3000)
  forceKill.unref()
  return true
}

export function registerClaudeManageRoutes(use: UseFn) {
  use("/api/claude/settings", (req, res, next) => {
    if (req.method !== "POST") return next()
    const match = (req.url ?? "").match(/^\/([^/?]+)$/)
    if (!match) return next()
    const sessionId = decodeURIComponent(match[1])
    collectRequestBody(req, async (body) => {
      try {
        const updates = JSON.parse(body) as SDKSessionUpdates
        const result = await updateSDKSession(sessionId, updates)
        sendJson(res, 200, { success: true, ...result })
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid Claude settings payload"))
      }
    })
  })

  use("/api/interrupt-session", (req, res, next) => {
    if (req.method !== "POST") return next()
    collectRequestBody(req, async (body) => {
      try {
        const { sessionId } = JSON.parse(body)
        if (!sessionId) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId is required"))
          return
        }
        const activeCodexTurnId = codexAppServer.getActiveTurnId(sessionId)
        const interrupted = activeCodexTurnId
          ? await codexAppServer.interruptTurn(sessionId, activeCodexTurnId).then(() => true)
          : await interruptSDKTurn(sessionId)
        sendJson(res, 200, { success: interrupted })
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
      }
    })
  })

  use("/api/claude/checkpoints", (req, res, next) => {
    if (req.method !== "POST") return next()
    const match = (req.url ?? "").match(/^\/([^/?]+)\/rewind$/)
    if (!match) return next()
    const sessionId = decodeURIComponent(match[1])
    collectRequestBody(req, async (body) => {
      try {
        const { userMessageId, cwd, dryRun } = JSON.parse(body)
        if (typeof userMessageId !== "string" || typeof cwd !== "string") {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "userMessageId and cwd are required"))
          return
        }
        const result = await rewindClaudeFiles(sessionId, userMessageId, cwd, dryRun === true)
        sendJson(res, 200, result)
      } catch (error) {
        sendError(res, new RouteError(
          502,
          ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : "Claude checkpoint rewind failed",
        ))
      }
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
      collectRequestBody(req, (body) => {
        let toolUseId: string | undefined
        try {
          const parsed = body ? JSON.parse(body) : {}
          toolUseId = typeof parsed.toolUseId === "string" ? parsed.toolUseId : undefined
        } catch {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
          return
        }
        void backgroundSDKTasks(decodeURIComponent(backgroundMatch[1]), toolUseId).then((backgrounded) => {
          sendJson(res, 200, { success: backgrounded })
        })
      })
      return
    }
    next()
  })

  use("/api/stop-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    collectRequestBody(req, async (body) => {
      try {
        const { sessionId } = JSON.parse(body)

        if (!sessionId) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId is required"))
          return
        }

        let stoppedNativeCodex = false
        const activeCodexTurnId = codexAppServer.getActiveTurnId(sessionId)
        if (activeCodexTurnId) {
          try {
            await codexAppServer.interruptTurn(sessionId, activeCodexTurnId)
            stoppedNativeCodex = true
          } catch {
            // Fall through to the legacy process controls below. This keeps
            // stop working with older CLIs and during app-server restarts.
          }
        }

        // Stop SDK session if present
        const stoppedSDK = stopSDKSession(sessionId)

        const hadPersistentSession = terminatePersistentSession(sessionId)

        const child = activeProcesses.get(sessionId)
        if (!child && !hadPersistentSession && !stoppedSDK && !stoppedNativeCodex) {
          sendJson(res, 200, { success: false, error: "No active process for this session" })
          return
        }

        if (child) {
          child.kill("SIGTERM")
          const forceKill = setTimeout(() => {
            if (activeProcesses.has(sessionId)) {
              child.kill("SIGKILL")
            }
          }, 3000)
          forceKill.unref()
        }

        sendJson(res, 200, { success: true })
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
      }
    })
  })

  use("/api/kill-all", (req, res, next) => {
    if (req.method !== "POST") return next()

    const activeNativeTurns = codexAppServer.listActiveTurns()

    const finishKillAll = (
      nativeResults: PromiseSettledResult<unknown>[],
    ) => {
      const interruptedNative = nativeResults.filter(
        (result) => result.status === "fulfilled",
      ).length
      const failedNative = nativeResults.length - interruptedNative
      let killed = interruptedNative

      // Build SIGKILL snapshot BEFORE clearing the Maps (fix for Bug #2:
      // previous code read from already-empty Maps after deletion loops).
      const sigkillProcs: ChildProcess[] = []
      for (const ps of persistentSessions.values()) sigkillProcs.push(ps.proc)
      for (const proc of activeProcesses.values()) sigkillProcs.push(proc)

      // Kill SDK sessions first
      killed += cleanupAllSDKSessions()

      // Snapshot keys before iterating to avoid mutating the Map mid-iteration
      // (fix for Bug #1: `persistentSessions.delete(sid)` inside a `for…of`
      // over the same Map is undefined behaviour in some engines).
      for (const [sid, ps] of [...persistentSessions.entries()]) {
        if (!ps.dead) {
          ps.dead = true
          try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
          killed++
        }
        persistentSessions.delete(sid)
      }

      for (const [sid, proc] of [...activeProcesses.entries()]) {
        try { proc.kill("SIGTERM") } catch { /* already dead */ }
        activeProcesses.delete(sid)
        killed++
      }

      if (sigkillProcs.length > 0) {
        const forceKill = setTimeout(() => {
          for (const p of sigkillProcs) {
            try { p.kill("SIGKILL") } catch { /* already dead */ }
          }
        }, 3000)
        forceKill.unref()
      }

      sendJson(res, 200, {
        success: failedNative === 0,
        killed,
        ...(failedNative > 0 ? { nativeInterruptFailures: failedNative } : {}),
      })
    }

    if (activeNativeTurns.length === 0) {
      finishKillAll([])
      return
    }

    // Native turns (including subagent turns) are not represented by a child
    // process per session. Interrupt every transport-reported turn before
    // cleaning up the legacy process maps.
    void Promise.allSettled(
      activeNativeTurns.map(({ threadId, turnId }) =>
        codexAppServer.interruptTurn(threadId, turnId),
      ),
    ).then(finishKillAll)
  })

  registerRunningProcessesRoute(use)

  use("/api/kill-process", (req, res, next) => {
    if (req.method !== "POST") return next()

    collectRequestBody(req, (body) => {
      try {
        const { pid } = JSON.parse(body)
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
    })
  })

  use("/api/delete-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    collectRequestBody(req, async (body) => {
      try {
        const { dirName, fileName } = JSON.parse(body)

        if (!dirName || !fileName) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "dirName and fileName are required"))
          return
        }

        const filePath = await resolveSessionFilePath(dirName, fileName)
        if (!filePath || (!isCodexDirName(dirName) && !isWithinDir(dirs.PROJECTS_DIR, filePath))) {
          sendError(res, new RouteError(403, ErrorCodes.FORBIDDEN, "Access denied"))
          return
        }

        const sessionId = fileName.replace(".jsonl", "")
        terminatePersistentSession(sessionId)
        const child = activeProcesses.get(sessionId)
        if (child) {
          child.kill("SIGTERM")
          activeProcesses.delete(sessionId)
          const forceKill = setTimeout(() => {
            try { child.kill("SIGKILL") } catch { /* already dead */ }
          }, 3000)
          forceKill.unref()
        }

        await unlink(filePath)

        sendJson(res, 200, { success: true })
      } catch (err) {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : "Failed to delete session"))
      }
    })
  })
}
