import type { UseFn } from "../../helpers"
import { dirs, isWithinDir, projectDirToReadableName, getSessionMeta, readdir, readFile, stat, join } from "../../helpers"
import { handleActiveSessions } from "./activeSessionsRoute"

export { handleActiveSessions } from "./activeSessionsRoute"

export function registerProjectRoutes(use: UseFn) {
  // GET /api/projects - list all projects
  use("/api/projects", async (_req, res, next) => {
    if (_req.method !== "GET") return next()
    // Only handle exact path
    if (_req.url && _req.url !== "/" && _req.url !== "") return next()

    try {
      const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
      const projects = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === "memory") continue

        const projectDir = join(dirs.PROJECTS_DIR, entry.name)
        const files = await readdir(projectDir)
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"))

        if (jsonlFiles.length === 0) continue

        // Get file stats for latest session
        let latestTime = 0
        let latestFile: string | null = null
        for (const f of jsonlFiles) {
          try {
            const s = await stat(join(projectDir, f))
            if (s.mtimeMs > latestTime) {
              latestTime = s.mtimeMs
              latestFile = f
            }
          } catch { /* ignore stat errors */ }
        }

        const { path: realPath, shortName } = projectDirToReadableName(entry.name)

        // Read cwd from the latest session to get the real filesystem path
        // (the path field derived from dirName is unreliable for dirs with hyphens)
        let cwd: string | null = null
        if (latestFile) {
          try {
            const meta = await getSessionMeta(join(projectDir, latestFile))
            cwd = meta.cwd ?? null
          } catch { /* ignore, fall back to derived path */ }
        }

        projects.push({
          dirName: entry.name,
          path: cwd ?? realPath,
          shortName,
          sessionCount: jsonlFiles.length,
          lastModified: latestTime ? new Date(latestTime).toISOString() : null,
        })
      }

      // Sort by last modified (most recent first)
      projects.sort((a, b) => {
        if (!a.lastModified) return 1
        if (!b.lastModified) return -1
        return b.lastModified.localeCompare(a.lastModified)
      })

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(projects))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  // GET /api/sessions/:dirName - list sessions / serve file content
  use("/api/sessions/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length === 1) {
      // List sessions for this project
      const dirName = decodeURIComponent(parts[0])
      const projectDir = join(dirs.PROJECTS_DIR, dirName)

      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      try {
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10))
        const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)), 200)

        const files = await readdir(projectDir)
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"))

        // Get file stats for sorting first (cheap operation)
        const fileStats = await Promise.all(
          jsonlFiles.map(async (f) => {
            try {
              const fileStat = await stat(join(projectDir, f))
              return { fileName: f, mtime: fileStat.mtime, size: fileStat.size }
            } catch {
              return { fileName: f, mtime: new Date(0), size: 0 }
            }
          })
        )

        // Sort by last modified (most recent first)
        fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

        const total = fileStats.length
        const start = (page - 1) * limit
        const paged = fileStats.slice(start, start + limit)

        // Only read metadata for the current page
        const sessions = []
        for (const fs of paged) {
          const filePath = join(projectDir, fs.fileName)
          try {
            const meta = await getSessionMeta(filePath)
            sessions.push({
              ...meta,
              fileName: fs.fileName,
              sessionId: meta.sessionId || fs.fileName.replace(".jsonl", ""),
              size: fs.size,
              lastModified: fs.mtime.toISOString(),
            })
          } catch {
            sessions.push({
              fileName: fs.fileName,
              sessionId: fs.fileName.replace(".jsonl", ""),
              size: fs.size,
              lastModified: fs.mtime.toISOString(),
            })
          }
        }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ sessions, total, page, pageSize: limit }))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(err) }))
      }
    } else if (parts.length >= 2) {
      // Serve session file content (supports nested paths like sessionId/subagents/file.jsonl)
      const dirName = decodeURIComponent(parts[0])
      const fileParts = parts.slice(1).map(decodeURIComponent)
      const fileName = fileParts.join("/")

      if (!fileName.endsWith(".jsonl")) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Only .jsonl files" }))
        return
      }

      const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
      if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }
      try {
        const content = await readFile(filePath, "utf-8")
        res.setHeader("Content-Type", "text/plain")
        res.end(content)
      } catch {
        res.statusCode = 404
        res.end(JSON.stringify({ error: "File not found" }))
      }
    } else {
      next()
    }
  })

  // GET /api/active-sessions - list most recent sessions across all projects
  use("/api/active-sessions", handleActiveSessions)

  // GET /api/find-session/:sessionId - find a session JSONL file by its session ID
  use("/api/find-session/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    const sessionId = decodeURIComponent(parts[0])
    const targetFile = `${sessionId}.jsonl`

    try {
      const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "memory") continue
        const projectDir = join(dirs.PROJECTS_DIR, entry.name)
        try {
          const files = await readdir(projectDir)
          if (files.includes(targetFile)) {
            res.setHeader("Content-Type", "application/json")
            res.end(
              JSON.stringify({
                dirName: entry.name,
                fileName: targetFile,
              })
            )
            return
          }
        } catch {
          continue
        }
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: "Session not found" }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
}
