import {
  activeProcesses,
  persistentSessions,
  spawn,
} from "../helpers"
import type { UseFn } from "../helpers"

export function registerClaudeManageRoutes(use: UseFn) {
  // POST /api/stop-session - stop a running claude child process
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

        // Kill persistent session if it exists
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
          // If it doesn't die within 3s, force kill
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

  // POST /api/kill-all - kill every active/persistent claude process
  use("/api/kill-all", (req, res, next) => {
    if (req.method !== "POST") return next()

    let killed = 0

    // Kill persistent sessions
    for (const [sid, ps] of persistentSessions) {
      if (!ps.dead) {
        ps.dead = true
        try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
        killed++
      }
      persistentSessions.delete(sid)
    }

    // Kill active (non-persistent) processes
    for (const [sid, proc] of activeProcesses) {
      try { proc.kill("SIGTERM") } catch { /* already dead */ }
      activeProcesses.delete(sid)
      killed++
    }

    // Force-kill after 3s if any survive
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

  // GET /api/running-processes - list all system-wide `claude` processes
  use("/api/running-processes", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const child = spawn("ps", ["aux"])
    let stdout = ""
    child.stdout!.on("data", (data: Buffer) => { stdout += data.toString() })
    child.on("close", () => {
      const processes: Array<{
        pid: number
        memMB: number
        cpu: number
        sessionId: string | null
        tty: string
        args: string
        startTime: string
      }> = []

      for (const line of stdout.split("\n")) {
        // Match claude processes but not node/esbuild/zsh wrappers
        if (!line.includes("claude") || line.includes("grep") ||
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

        // Extract session ID from --resume or --session-id flags
        let sessionId: string | null = null
        const resumeMatch = args.match(/--resume\s+([0-9a-f-]{36})/)
        const sidMatch = args.match(/--session-id\s+([0-9a-f-]{36})/)
        sessionId = resumeMatch?.[1] ?? sidMatch?.[1] ?? null

        processes.push({
          pid,
          memMB: Math.round(memKB / 1024),
          cpu,
          sessionId,
          tty,
          args,
          startTime,
        })
      }

      // Sort by memory descending
      processes.sort((a, b) => b.memMB - a.memMB)

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(processes))
    })
    child.on("error", () => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: "Failed to list processes" }))
    })
  })

  // POST /api/kill-process - kill a specific process by PID (only tracked claude processes)
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

        // Only allow killing PIDs that we are tracking
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
          res.end(JSON.stringify({ error: "Can only kill tracked claude processes" }))
          return
        }

        try {
          process.kill(pid, "SIGTERM")
          // Force-kill after 3s
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
}
