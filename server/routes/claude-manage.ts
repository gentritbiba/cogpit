import {
  activeProcesses,
  persistentSessions,
  dirs,
  isCodexDirName,
  isWithinDir,
  unlink,
  join,
  resolveSessionFilePath,
  spawn,
} from "../helpers"
import type { UseFn } from "../helpers"

export function registerClaudeManageRoutes(use: UseFn) {
  use("/api/stop-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const { sessionId } = JSON.parse(body)

        if (!sessionId) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "sessionId is required" }))
          return
        }

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
        if (!child && !ps) {
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
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })

  use("/api/kill-all", (req, res, next) => {
    if (req.method !== "POST") return next()

    let killed = 0

    for (const [sid, ps] of persistentSessions) {
      if (!ps.dead) {
        ps.dead = true
        try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
        killed++
      }
      persistentSessions.delete(sid)
    }

    for (const [sid, proc] of activeProcesses) {
      try { proc.kill("SIGTERM") } catch { /* already dead */ }
      activeProcesses.delete(sid)
      killed++
    }

    if (killed > 0) {
      const snapshot = [...persistentSessions.values()].map(p => p.proc).concat([...activeProcesses.values()])
      const forceKill = setTimeout(() => {
        for (const p of snapshot) {
          try { p.kill("SIGKILL") } catch { /* already dead */ }
        }
      }, 3000)
      forceKill.unref()
    }

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ success: true, killed }))
  })

  use("/api/running-processes", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

      const child = spawn("ps", ["aux"])
      let stdout = ""
      child.stdout!.on("data", (data: Buffer) => { stdout += data.toString() })
      child.on("close", () => {
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
        const agentKind = args.includes("codex") ? "codex" : "claude"

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

      processes.sort((a, b) => b.memMB - a.memMB)

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(processes))
    })
    child.on("error", () => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: "Failed to list processes" }))
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
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Valid pid required" }))
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
          res.statusCode = 403
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Can only kill tracked agent processes" }))
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
          res.statusCode = 404
          res.end(JSON.stringify({ error: "Process not found or already dead" }))
        }
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
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
          res.statusCode = 400
          res.end(JSON.stringify({ error: "dirName and fileName are required" }))
          return
        }

        const filePath = await resolveSessionFilePath(dirName, fileName)
        if (!filePath || (!isCodexDirName(dirName) && !isWithinDir(dirs.PROJECTS_DIR, filePath))) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
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
        res.statusCode = 400
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to delete session",
          })
        )
      }
    })
  })
}
