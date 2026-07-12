import {
  activeProcesses,
  persistentSessions,
  dirs,
  isCodexDirName,
  isWithinDir,
  unlink,
  resolveSessionFilePath,
  spawn,
} from "../helpers"
import type { UseFn } from "../helpers"
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

export function registerClaudeManageRoutes(use: UseFn) {
  use("/api/claude/settings", (req, res, next) => {
    if (req.method !== "POST") return next()
    const match = (req.url ?? "").match(/^\/([^/?]+)$/)
    if (!match) return next()
    const sessionId = decodeURIComponent(match[1])
    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", async () => {
      try {
        const updates = JSON.parse(body) as SDKSessionUpdates
        const result = await updateSDKSession(sessionId, updates)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: true, ...result }))
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid Claude settings payload"))
      }
    })
  })

  use("/api/interrupt-session", (req, res, next) => {
    if (req.method !== "POST") return next()
    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", async () => {
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
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: interrupted }))
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
    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", async () => {
      try {
        const { userMessageId, cwd, dryRun } = JSON.parse(body)
        if (typeof userMessageId !== "string" || typeof cwd !== "string") {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "userMessageId and cwd are required"))
          return
        }
        const result = await rewindClaudeFiles(sessionId, userMessageId, cwd, dryRun === true)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(result))
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
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: stopped }))
      }, (error) => {
        sendError(res, new RouteError(502, ErrorCodes.INTERNAL_ERROR, String(error)))
      })
      return
    }
    if (req.method === "POST" && backgroundMatch) {
      let body = ""
      req.on("data", (chunk: string) => { body += chunk })
      req.on("end", () => {
        let toolUseId: string | undefined
        try {
          const parsed = body ? JSON.parse(body) : {}
          toolUseId = typeof parsed.toolUseId === "string" ? parsed.toolUseId : undefined
        } catch {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
          return
        }
        void backgroundSDKTasks(decodeURIComponent(backgroundMatch[1]), toolUseId).then((backgrounded) => {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: backgrounded }))
        })
      })
      return
    }
    next()
  })

  use("/api/stop-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
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

        const ps = persistentSessions.get(sessionId)
        if (ps && !ps.dead) {
          ps.dead = true
          ps.proc.kill("SIGTERM")
          persistentSessions.delete(sessionId)
          const forceKillPs = setTimeout(() => {
            try { ps.proc.kill("SIGKILL") } catch { /* already dead */ }
          }, 3000)
          forceKillPs.unref()
        }

        const child = activeProcesses.get(sessionId)
        if (!child && !ps && !stoppedSDK && !stoppedNativeCodex) {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: false, error: "No active process for this session" }))
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

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: true }))
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
      const sigkillProcs: Array<{ kill(sig: string): void }> = []
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

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({
        success: failedNative === 0,
        killed,
        ...(failedNative > 0 ? { nativeInterruptFailures: failedNative } : {}),
      }))
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

  use("/api/running-processes", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const isWin = process.platform === "win32"
    const child = isWin
      ? spawn("powershell", ["-NoProfile", "-Command",
          "Get-CimInstance Win32_Process -Filter \"name like '%claude%' or name like '%codex%'\" | Select-Object ProcessId, WorkingSetSize, CommandLine | ConvertTo-Json -Compress"])
      : spawn("ps", ["aux"])
    let stdout = ""
    let responded = false
    child.stdout!.on("data", (data: Buffer) => { stdout += data.toString() })
    child.on("close", () => {
      if (responded) return
      responded = true

      const trackedByPid = new Map<number, string>()
      for (const [sid, ps] of persistentSessions) {
        if (ps.proc.pid) trackedByPid.set(ps.proc.pid, sid)
      }
      for (const [sid, proc] of activeProcesses) {
        if (proc.pid && !trackedByPid.has(proc.pid)) trackedByPid.set(proc.pid, sid)
      }

      const processes: Array<{
        pid: number
        memMB: number
        cpu: number
        sessionId: string | null
        agentKind: "claude" | "codex"
        tty: string
        args: string
        startTime: string
      }> = []

      if (isWin) {
        try {
          const parsed = JSON.parse(stdout)
          const items = Array.isArray(parsed) ? parsed : [parsed]
          for (const item of items) {
            const cmdLine = item.CommandLine || ""
            if (!cmdLine.includes("claude") && !cmdLine.includes("codex")) continue
            const pid = item.ProcessId
            const memBytes = item.WorkingSetSize || 0
            const agentKind = cmdLine.includes("codex") ? "codex" as const : "claude" as const

            const resumeMatch = cmdLine.match(/--resume\s+([0-9a-f-]{36})/)
            const sidMatch = cmdLine.match(/--session-id\s+([0-9a-f-]{36})/)
            const codexResumeMatch = cmdLine.match(/codex(?:\s+\S+)*\s+exec\s+resume\s+([0-9a-f-]{36})/)
            const sessionId = trackedByPid.get(pid) ?? resumeMatch?.[1] ?? sidMatch?.[1] ?? codexResumeMatch?.[1] ?? null

            processes.push({
              pid,
              memMB: Math.round(memBytes / 1024 / 1024),
              cpu: 0,
              sessionId,
              agentKind,
              tty: "??",
              args: cmdLine,
              startTime: "",
            })
          }
        } catch {
          // PowerShell returned no results or invalid JSON — return empty list
        }
      } else {
        for (const line of stdout.split("\n")) {
          if ((!line.includes("claude") && !line.includes("codex")) || line.includes("grep") ||
              line.includes("node ") || line.includes("esbuild") ||
              line.includes("/bin/zsh")) continue

          const cols = line.trim().split(/\s+/)
          if (cols.length < 11) continue

          const pid = parseInt(cols[1], 10)
          const cpu = parseFloat(cols[2]) || 0
          const memKB = parseInt(cols[5], 10) || 0
          const tty = cols[6] || "??"
          const startTime = cols[8] || ""
          const args = cols.slice(10).join(" ")
          const agentKind = args.includes("codex") ? "codex" as const : "claude" as const

          const resumeMatch = args.match(/--resume\s+([0-9a-f-]{36})/)
          const sidMatch = args.match(/--session-id\s+([0-9a-f-]{36})/)
          const codexResumeMatch = args.match(/codex(?:\s+\S+)*\s+exec\s+resume\s+([0-9a-f-]{36})/)
          const sessionId = trackedByPid.get(pid) ?? resumeMatch?.[1] ?? sidMatch?.[1] ?? codexResumeMatch?.[1] ?? null

          processes.push({
            pid,
            memMB: Math.round(memKB / 1024),
            cpu,
            sessionId,
            agentKind,
            tty,
            args,
            startTime,
          })
        }
      }

      processes.sort((a, b) => b.memMB - a.memMB)

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(processes))
    })
    child.on("error", () => {
      if (responded) return
      responded = true
      sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Failed to list processes"))
    })
  })

  use("/api/kill-process", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", () => {
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

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, pid }))
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

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
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
        const ps = persistentSessions.get(sessionId)
        if (ps && !ps.dead) {
          ps.dead = true
          ps.proc.kill("SIGTERM")
          persistentSessions.delete(sessionId)
          const forceKillPs = setTimeout(() => {
            try { ps.proc.kill("SIGKILL") } catch { /* already dead */ }
          }, 3000)
          forceKillPs.unref()
        }
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

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: true }))
      } catch (err) {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : "Failed to delete session"))
      }
    })
  })
}
