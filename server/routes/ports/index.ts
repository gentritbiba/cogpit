import {
  spawn,
  createConnection,
} from "../../helpers"
import type { UseFn } from "../../helpers"
import { handleBackgroundTasks } from "./backgroundTasks"
import { handleBackgroundAgents } from "./backgroundAgents"

export { handleBackgroundTasks } from "./backgroundTasks"
export { handleBackgroundAgents } from "./backgroundAgents"

export function registerPortRoutes(use: UseFn) {
  // GET /api/check-ports?ports=3000,5173 - check which ports are listening
  use("/api/check-ports", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const portsParam = url.searchParams.get("ports")
    if (!portsParam) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: "ports query param required" }))
      return
    }

    const ports = portsParam
      .split(",")
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => p > 0 && p < 65536)

    const results: Record<number, boolean> = {}

    await Promise.all(
      ports.map(
        (port) =>
          new Promise<void>((resolve) => {
            const socket = createConnection({ port, host: "127.0.0.1" })
            socket.setTimeout(500)
            socket.on("connect", () => {
              results[port] = true
              socket.destroy()
              resolve()
            })
            socket.on("timeout", () => {
              results[port] = false
              socket.destroy()
              resolve()
            })
            socket.on("error", () => {
              results[port] = false
              resolve()
            })
          })
      )
    )

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(results))
  })

  // GET /api/background-tasks?cwd=<path> - scan Claude's task output directory
  use("/api/background-tasks", handleBackgroundTasks)

  // POST /api/kill-port - kill process listening on a given port (unprivileged ports only)
  use("/api/kill-port", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const { port } = JSON.parse(body)
        if (!port || port < 1 || port > 65535) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Valid port required" }))
          return
        }

        // Only allow killing processes on unprivileged ports (>1024)
        // This prevents killing system services (SSH=22, HTTP=80, HTTPS=443, etc.)
        if (port <= 1024) {
          res.statusCode = 403
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Cannot kill processes on privileged ports (<=1024)" }))
          return
        }

        // Use lsof to find PIDs on this port, then kill them
        const child = spawn("lsof", [
          "-t",
          "-i",
          `:${port}`,
          "-sTCP:LISTEN",
        ])

        let stdout = ""
        child.stdout!.on("data", (data: Buffer) => {
          stdout += data.toString()
        })

        child.on("close", () => {
          const pids = stdout
            .trim()
            .split("\n")
            .map((p) => parseInt(p, 10))
            .filter((p) => p > 0)

          if (pids.length === 0) {
            res.setHeader("Content-Type", "application/json")
            res.end(
              JSON.stringify({
                success: false,
                error: "No process found on port",
              })
            )
            return
          }

          let killed = 0
          for (const pid of pids) {
            try {
              process.kill(pid, "SIGTERM")
              killed++
            } catch {
              // process may have already exited
            }
          }

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, killed, pids }))
        })

        child.on("error", (err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: err.message }))
        })
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })

  // GET /api/background-agents?cwd=<path> - find background agent sessions (symlinks in tasks dir)
  use("/api/background-agents", handleBackgroundAgents)
}
