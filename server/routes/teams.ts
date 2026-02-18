import {
  dirs,
  isWithinDir,
  readdir,
  readFile,
  writeFile,
  join,
  watch,
} from "../helpers"
import type { UseFn } from "../helpers"

export function registerTeamRoutes(use: UseFn) {
  // GET /api/teams - list all teams with task progress summary
  use("/api/teams", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)

    // Only handle exact /api/teams (no sub-path)
    if (pathParts.length > 0) return next()

    try {
      let teamDirs: string[]
      try {
        const entries = await readdir(dirs.TEAMS_DIR, { withFileTypes: true })
        teamDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      } catch {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify([]))
        return
      }

      const teams = []
      for (const teamName of teamDirs) {
        try {
          const configPath = join(dirs.TEAMS_DIR, teamName, "config.json")
          const configRaw = await readFile(configPath, "utf-8")
          const config = JSON.parse(configRaw)

          // Count tasks
          const taskSummary = { total: 0, completed: 0, inProgress: 0, pending: 0 }
          try {
            const taskDir = join(dirs.TASKS_DIR, teamName)
            const taskFiles = await readdir(taskDir)
            for (const tf of taskFiles.filter((f) => f.endsWith(".json"))) {
              try {
                const taskRaw = await readFile(join(taskDir, tf), "utf-8")
                const task = JSON.parse(taskRaw)
                if (task.status === "deleted") continue
                taskSummary.total++
                if (task.status === "completed") taskSummary.completed++
                else if (task.status === "in_progress") taskSummary.inProgress++
                else taskSummary.pending++
              } catch { /* skip bad task files */ }
            }
          } catch { /* no tasks dir */ }

          // Find lead name
          const leadMember = config.members?.find(
            (m: { agentType?: string }) => m.agentType === "team-lead"
          )

          teams.push({
            name: config.name || teamName,
            description: config.description || "",
            createdAt: config.createdAt || 0,
            memberCount: config.members?.length || 0,
            leadName: leadMember?.name || "unknown",
            taskSummary,
          })
        } catch { /* skip teams with bad config */ }
      }

      // Sort by createdAt descending
      teams.sort((a, b) => b.createdAt - a.createdAt)

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(teams))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  // GET /api/team-detail/:teamName - full team detail
  use("/api/team-detail/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 1) return next()

    const teamName = decodeURIComponent(parts[0])
    const teamDir = join(dirs.TEAMS_DIR, teamName)

    if (!isWithinDir(dirs.TEAMS_DIR, teamDir)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }

    try {
      // Read config
      const configRaw = await readFile(join(teamDir, "config.json"), "utf-8")
      const config = JSON.parse(configRaw)

      // Read tasks
      const tasks: unknown[] = []
      try {
        const taskDir = join(dirs.TASKS_DIR, teamName)
        const taskFiles = await readdir(taskDir)
        for (const tf of taskFiles.filter((f) => f.endsWith(".json"))) {
          try {
            const taskRaw = await readFile(join(taskDir, tf), "utf-8")
            const task = JSON.parse(taskRaw)
            if (task.status !== "deleted") tasks.push(task)
          } catch { /* skip */ }
        }
      } catch { /* no tasks */ }

      // Read inboxes
      const inboxes: Record<string, unknown[]> = {}
      try {
        const inboxDir = join(teamDir, "inboxes")
        const inboxFiles = await readdir(inboxDir)
        for (const inf of inboxFiles.filter((f) => f.endsWith(".json"))) {
          try {
            const inboxRaw = await readFile(join(inboxDir, inf), "utf-8")
            const messages = JSON.parse(inboxRaw)
            const memberName = inf.replace(".json", "")
            inboxes[memberName] = Array.isArray(messages) ? messages : []
          } catch { /* skip */ }
        }
      } catch { /* no inboxes */ }

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ config, tasks, inboxes }))
    } catch {
      res.statusCode = 404
      res.end(JSON.stringify({ error: "Team not found" }))
    }
  })

  // GET /api/team-watch/:teamName - SSE for live team updates
  use("/api/team-watch/", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 1) return next()

    const teamName = decodeURIComponent(parts[0])
    const teamDir = join(dirs.TEAMS_DIR, teamName)
    const taskDir = join(dirs.TASKS_DIR, teamName)

    if (!isWithinDir(dirs.TEAMS_DIR, teamDir)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const sendUpdate = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        res.write(`data: ${JSON.stringify({ type: "update" })}\n\n`)
      }, 500)
    }

    // Watch team config dir (config + inboxes)
    const watchers: ReturnType<typeof watch>[] = []
    try {
      const w = watch(teamDir, { recursive: true }, sendUpdate)
      w.on("error", () => {}) // prevent uncaught crash when dir is removed
      watchers.push(w)
    } catch { /* dir may not exist */ }
    try {
      const w = watch(taskDir, { recursive: true }, sendUpdate)
      w.on("error", () => {}) // prevent uncaught crash when dir is removed
      watchers.push(w)
    } catch { /* dir may not exist */ }

    res.write(`data: ${JSON.stringify({ type: "init" })}\n\n`)

    // Heartbeat
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n")
    }, 15000)

    // Cleanup
    req.on("close", () => {
      for (const w of watchers) w.close()
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(heartbeat)
    })
  })

  // POST /api/team-message/:teamName/:memberName - send message to a team member's inbox
  use("/api/team-message/", (req, res, next) => {
    if (req.method !== "POST") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 2) return next()

    const teamName = decodeURIComponent(parts[0])
    const memberName = decodeURIComponent(parts[1])
    const inboxPath = join(dirs.TEAMS_DIR, teamName, "inboxes", `${memberName}.json`)

    if (!isWithinDir(dirs.TEAMS_DIR, inboxPath)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { message } = JSON.parse(body)
        if (!message || typeof message !== "string") {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "message is required" }))
          return
        }

        // Read existing inbox
        let inbox: unknown[] = []
        try {
          const raw = await readFile(inboxPath, "utf-8")
          inbox = JSON.parse(raw)
          if (!Array.isArray(inbox)) inbox = []
        } catch {
          // file doesn't exist yet, start with empty array
        }

        // Append new message
        const newMsg = {
          from: "user",
          text: message,
          timestamp: new Date().toISOString(),
          color: undefined,
          read: false,
        }
        inbox.push(newMsg)

        await writeFile(inboxPath, JSON.stringify(inbox, null, 2), "utf-8")

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: true }))
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })
}
