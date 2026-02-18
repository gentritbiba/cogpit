import {
  spawn,
  stat,
  open,
  lstat,
  readdir,
  join,
  createConnection,
} from "../helpers"
import type { UseFn } from "../helpers"

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
  use("/api/background-tasks", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const cwd = url.searchParams.get("cwd")
    if (!cwd) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: "cwd query param required" }))
      return
    }

    try {
      const uid = process.getuid?.() ?? 501
      const tmpBase = `/private/tmp/claude-${uid}`

      const projectHash = cwd.replace(/\//g, "-").replace(/ /g, "-").replace(/@/g, "-").replace(/\./g, "-")
      const tasksDir = join(tmpBase, projectHash, "tasks")

      let files: string[]
      try {
        files = await readdir(tasksDir)
      } catch {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify([]))
        return
      }

      const PORT_RE = /(?::(\d{4,5}))|(?:localhost:(\d{4,5}))|(?:port\s+(\d{4,5}))/gi
      const tasks: Array<{
        id: string
        outputPath: string
        ports: number[]
        preview: string
        modifiedAt: number
      }> = []

      for (const f of files) {
        if (!f.endsWith(".output")) continue
        const fullPath = join(tasksDir, f)

        // Skip symlinks (those are subagent tasks, not bash background tasks)
        try {
          const lstats = await lstat(fullPath)
          if (lstats.isSymbolicLink()) continue
        } catch { continue }

        const taskId = f.replace(".output", "")

        // Read content to detect ports and get a preview
        let content = ""
        let modifiedAt = 0
        try {
          const s = await stat(fullPath)
          modifiedAt = s.mtimeMs
          if (s.size === 0) continue // skip empty output files
          const fh = await open(fullPath, "r")
          try {
            const buf = Buffer.alloc(Math.min(s.size, 8192))
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
            content = buf.subarray(0, bytesRead).toString("utf-8")
          } finally {
            await fh.close()
          }
        } catch { continue }

        // Detect ports from output content
        const ports = new Set<number>()
        for (const m of content.matchAll(PORT_RE)) {
          const p = parseInt(m[1] || m[2] || m[3], 10)
          if (p > 0 && p < 65536) ports.add(p)
        }

        if (ports.size === 0) continue // skip tasks with no detected ports

        const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("[2K"))
        const preview = lines.slice(0, 5).join("\n").slice(0, 300)

        tasks.push({
          id: taskId,
          outputPath: fullPath,
          ports: [...ports],
          preview,
          modifiedAt,
        })
      }

      // TCP-probe all detected ports for liveness
      const allPorts = [...new Set(tasks.flatMap((t) => t.ports))]
      const portAlive: Record<number, boolean> = {}
      await Promise.all(
        allPorts.map(
          (port) =>
            new Promise<void>((resolve) => {
              const socket = createConnection({ port, host: "127.0.0.1" })
              socket.setTimeout(500)
              socket.on("connect", () => { portAlive[port] = true; socket.destroy(); resolve() })
              socket.on("timeout", () => { portAlive[port] = false; socket.destroy(); resolve() })
              socket.on("error", () => { portAlive[port] = false; resolve() })
            })
        )
      )

      // Only return tasks that have at least one active port
      const portOwner = new Map<number, (typeof tasks)[0]>()
      for (const task of tasks) {
        for (const port of task.ports) {
          if (!portAlive[port]) continue
          const existing = portOwner.get(port)
          if (!existing || task.modifiedAt > existing.modifiedAt) {
            portOwner.set(port, task)
          }
        }
      }

      // Deduplicate tasks (a task may own multiple ports)
      const seen = new Set<string>()
      const result: Array<{
        id: string
        outputPath: string
        ports: number[]
        portStatus: Record<number, boolean>
        preview: string
      }> = []
      for (const task of portOwner.values()) {
        if (seen.has(task.id)) continue
        seen.add(task.id)
        const ps: Record<number, boolean> = {}
        for (const p of task.ports) ps[p] = !!portAlive[p]
        result.push({
          id: task.id,
          outputPath: task.outputPath,
          ports: task.ports,
          portStatus: ps,
          preview: task.preview,
        })
      }

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(result))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

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
}
