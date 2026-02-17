import type { Plugin } from "vite"
import type { ChildProcess } from "node:child_process"
import { readdir, readFile, writeFile, appendFile, stat, lstat, open, mkdir, unlink } from "node:fs/promises"
import { watch } from "node:fs"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"

import { getConfig, loadConfig, saveConfig, validateClaudeDir, getDirs } from "./config"

// Mutable directory references, updated when config changes
let dirs = {
  PROJECTS_DIR: "",
  TEAMS_DIR: "",
  TASKS_DIR: "",
  UNDO_DIR: "",
}

function refreshDirs(): boolean {
  const config = getConfig()
  if (!config) return false
  dirs = getDirs(config.claudeDir)
  return true
}

function isWithinDir(parent: string, child: string): boolean {
  const resolved = resolve(child)
  return resolved.startsWith(resolve(parent) + "/") || resolved === resolve(parent)
}

/**
 * Match a subagent JSONL file to a team member by checking the first line
 * for the member's name or prompt snippet.
 */
async function matchSubagentToMember(
  leadSessionId: string,
  subagentFileName: string,
  members: Array<{ name: string; agentType: string; prompt?: string }>
): Promise<string | null> {
  const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "memory") continue
    const filePath = join(
      dirs.PROJECTS_DIR,
      entry.name,
      leadSessionId,
      "subagents",
      subagentFileName
    )

    try {
      const fh = await open(filePath, "r")
      try {
        const buf = Buffer.alloc(16384)
        const { bytesRead } = await fh.read(buf, 0, 16384, 0)
        const firstLine =
          buf
            .subarray(0, bytesRead)
            .toString("utf-8")
            .split("\n")[0] || ""

        for (const member of members) {
          if (member.agentType === "team-lead") continue
          const prompt = member.prompt || ""
          const snippet = prompt.slice(0, 120)
          const terms = [
            member.name,
            member.name.replace(/-/g, " "),
            ...(snippet
              ? [snippet, snippet.replace(/"/g, '\\"')]
              : []),
          ]
          if (terms.some((t) => firstLine.includes(t))) {
            return member.name
          }
        }
      } finally {
        await fh.close()
      }
    } catch {
      continue
    }
  }

  return null
}

// Build dynamic home-directory prefix for stripping from project dir names
const HOME_PREFIX = homedir().replace(/\//g, "-").replace(/^-/, "").toLowerCase()

function projectDirToReadableName(dirName: string): { path: string; shortName: string } {
  // The dir name uses dashes for path separators: "-Users-username-Code-my-project"
  const raw = dirName.replace(/^-/, "")
  const lowerRaw = raw.toLowerCase()

  // Dynamically strip home directory prefix and common subdirs
  let shortPart = raw
  const homePrefix = HOME_PREFIX + "-"
  if (lowerRaw.startsWith(homePrefix)) {
    const afterHome = raw.slice(homePrefix.length)
    const lowerAfter = afterHome.toLowerCase()
    // Strip common subdirectories after home
    const subdirs = ["desktop-", "documents-", "code-", "projects-", "repos-", "dev-"]
    let stripped = false
    for (const sub of subdirs) {
      if (lowerAfter.startsWith(sub)) {
        shortPart = afterHome.slice(sub.length)
        stripped = true
        break
      }
    }
    if (!stripped) {
      shortPart = afterHome
    }
  }

  const shortName = shortPart || raw

  return {
    path: "/" + raw.replace(/-/g, "/"),
    shortName,
  }
}

async function getSessionMeta(filePath: string) {
  // Read only the first 32KB for metadata extraction (metadata is always near the top)
  // Fall back to full read only for turnCount accuracy
  let lines: string[]
  let isPartialRead = false
  const fileStat = await stat(filePath)

  if (fileStat.size > 65536) {
    // Large file: read first 32KB for metadata, count turns from line count estimate
    const fh = await open(filePath, "r")
    try {
      const buf = Buffer.alloc(32768)
      const { bytesRead } = await fh.read(buf, 0, 32768, 0)
      const text = buf.subarray(0, bytesRead).toString("utf-8")
      // Drop last (potentially incomplete) line
      const lastNewline = text.lastIndexOf("\n")
      lines = (lastNewline > 0 ? text.slice(0, lastNewline) : text).split("\n").filter(Boolean)
      isPartialRead = true
    } finally {
      await fh.close()
    }
  } else {
    const content = await readFile(filePath, "utf-8")
    lines = content.split("\n").filter(Boolean)
  }

  let sessionId = ""
  let version = ""
  let gitBranch = ""
  let model = ""
  let slug = ""
  let cwd = ""
  let firstUserMessage = ""
  let lastUserMessage = ""
  let timestamp = ""
  let turnCount = 0

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId
      if (obj.version && !version) version = obj.version
      if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch
      if (obj.slug && !slug) slug = obj.slug
      if (obj.cwd && !cwd) cwd = obj.cwd
      if (obj.type === "assistant" && obj.message?.model && !model) {
        model = obj.message.model
      }
      if (obj.type === "user" && !obj.isMeta && !timestamp) {
        timestamp = obj.timestamp || ""
      }
      if (obj.type === "user" && !obj.isMeta) {
        const c = obj.message?.content
        let extracted = ""
        if (typeof c === "string") {
          const cleaned = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
          if (cleaned && cleaned.length > 5) extracted = cleaned.slice(0, 120)
        } else if (Array.isArray(c)) {
          for (const block of c) {
            if (block.type === "text") {
              const cleaned = block.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
              if (cleaned && cleaned.length > 5) {
                extracted = cleaned.slice(0, 120)
                break
              }
            }
          }
        }
        if (extracted) {
          if (!firstUserMessage) firstUserMessage = extracted
          lastUserMessage = extracted
        }
        turnCount++
      }
    } catch {
      // skip malformed
    }
  }

  return {
    sessionId,
    version,
    gitBranch,
    model,
    slug,
    cwd,
    firstUserMessage,
    lastUserMessage,
    timestamp,
    turnCount: isPartialRead ? turnCount : turnCount, // partial reads give approximate count
    lineCount: isPartialRead ? Math.round(fileStat.size / (32768 / lines.length)) : lines.length,
  }
}

// Track active claude child processes by sessionId so we can stop them
const activeProcesses = new Map<string, ReturnType<typeof spawn>>()

// ── Persistent sessions ──────────────────────────────────────────────
// Keep one long-lived `claude` process per session so the Anthropic
// prompt-cache stays warm across messages (saves ~10k+ cache_creation
// tokens per message).
interface PersistentSession {
  proc: ChildProcess
  /** Resolves when the current turn's `result` message arrives */
  onResult: ((msg: { type: string; subtype?: string; is_error?: boolean; result?: string }) => void) | null
  /** Set to true once the process has exited */
  dead: boolean
  cwd: string
  permArgs: string[]
  modelArgs: string[]
  /** Path to the session's JSONL file (for forwarding progress events) */
  jsonlPath: string | null
}
const persistentSessions = new Map<string, PersistentSession>()

/** Find the JSONL file path for a session by searching all project directories. */
async function findJsonlPath(sessionId: string): Promise<string | null> {
  const targetFile = `${sessionId}.jsonl`
  try {
    const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "memory") continue
      const projectDir = join(dirs.PROJECTS_DIR, entry.name)
      try {
        const files = await readdir(projectDir)
        if (files.includes(targetFile)) {
          return join(projectDir, targetFile)
        }
      } catch { continue }
    }
  } catch { /* dirs.PROJECTS_DIR might not exist */ }
  return null
}

export function sessionApiPlugin(): Plugin {
  return {
    name: "session-api",
    configureServer(server) {
      // Kill all active child processes when the server shuts down
      server.httpServer?.on("close", () => {
        for (const [sid, proc] of activeProcesses) {
          try { proc.kill("SIGTERM") } catch { /* already dead */ }
          activeProcesses.delete(sid)
        }
        for (const [sid, ps] of persistentSessions) {
          try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
          persistentSessions.delete(sid)
        }
      })

      // Load config on startup
      loadConfig().then(() => refreshDirs())

      // Guard middleware: block data APIs when not configured
      server.middlewares.use((req, res, next) => {
        const url = req.url || ""
        // Allow config endpoints through without guard
        if (url.startsWith("/api/config")) return next()
        // Allow non-API requests through (HTML, JS, CSS)
        if (!url.startsWith("/api/")) return next()
        // Block data APIs when not configured
        if (!getConfig()) {
          res.statusCode = 503
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Not configured", code: "NOT_CONFIGURED" }))
          return
        }
        // Refresh dirs from current config
        refreshDirs()
        next()
      })

      // GET /api/config/validate?path=... - validate a path without saving
      server.middlewares.use("/api/config/validate", async (req, res, next) => {
        if (req.method !== "GET") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const dirPath = url.searchParams.get("path")

        if (!dirPath) {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ valid: false, error: "path query param required" }))
          return
        }

        const result = await validateClaudeDir(dirPath)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(result))
      })

      // GET /api/config - return current config (or null)
      // POST /api/config - validate and save config
      server.middlewares.use("/api/config", async (req, res, next) => {
        if (req.method === "GET") {
          // Only handle exact path
          if (req.url && req.url !== "/" && req.url !== "" && !req.url.startsWith("?")) return next()
          const config = getConfig()
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify(config))
          return
        }

        if (req.method === "POST") {
          let body = ""
          req.on("data", (chunk: Buffer) => { body += chunk.toString() })
          req.on("end", async () => {
            try {
              const { claudeDir } = JSON.parse(body)
              if (!claudeDir || typeof claudeDir !== "string") {
                res.statusCode = 400
                res.setHeader("Content-Type", "application/json")
                res.end(JSON.stringify({ error: "claudeDir string required" }))
                return
              }

              const validation = await validateClaudeDir(claudeDir)
              if (!validation.valid) {
                res.statusCode = 400
                res.setHeader("Content-Type", "application/json")
                res.end(JSON.stringify({ error: validation.error }))
                return
              }

              await saveConfig({ claudeDir: validation.resolved || claudeDir })
              refreshDirs()

              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ success: true, claudeDir: validation.resolved || claudeDir }))
            } catch {
              res.statusCode = 400
              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ error: "Invalid JSON body" }))
            }
          })
          return
        }

        next()
      })

      // GET /api/projects - list all projects
      server.middlewares.use("/api/projects", async (_req, res, next) => {
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
            for (const f of jsonlFiles) {
              try {
                const s = await stat(join(projectDir, f))
                if (s.mtimeMs > latestTime) latestTime = s.mtimeMs
              } catch { /* ignore stat errors */ }
            }

            const { path: realPath, shortName } = projectDirToReadableName(entry.name)

            projects.push({
              dirName: entry.name,
              path: realPath,
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

      // GET /api/projects/:dirName/sessions - list sessions for a project
      server.middlewares.use("/api/sessions/", async (req, res, next) => {
        if (req.method !== "GET") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const parts = url.pathname.split("/").filter(Boolean)

        // /api/sessions/:dirName -> list sessions
        // /api/sessions/:dirName/:sessionFile -> serve file content
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
      server.middlewares.use("/api/active-sessions", async (_req, res, next) => {
        if (_req.method !== "GET") return next()
        if (_req.url && !_req.url.startsWith("?") && _req.url !== "/" && _req.url !== "") return next()

        const url = new URL(_req.url || "/", "http://localhost")
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "30", 10), 100)

        try {
          const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })

          // First pass: collect all session files with their mtime (cheap stat only)
          const candidates: Array<{
            dirName: string
            fileName: string
            filePath: string
            mtimeMs: number
            size: number
          }> = []

          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === "memory") continue
            const projectDir = join(dirs.PROJECTS_DIR, entry.name)

            let files: string[]
            try {
              files = await readdir(projectDir)
            } catch {
              continue
            }
            const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"))

            for (const f of jsonlFiles) {
              const filePath = join(projectDir, f)
              try {
                const s = await stat(filePath)
                candidates.push({
                  dirName: entry.name,
                  fileName: f,
                  filePath,
                  mtimeMs: s.mtimeMs,
                  size: s.size,
                })
              } catch {
                // skip inaccessible files
              }
            }
          }

          // Sort by mtime descending and take top N
          candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
          const top = candidates.slice(0, limit)

          // Second pass: read metadata only for top N sessions
          const activeSessions = []
          const now = Date.now()

          for (const c of top) {
            try {
              const meta = await getSessionMeta(c.filePath)
              const { shortName } = projectDirToReadableName(c.dirName)
              const lastModified = new Date(c.mtimeMs).toISOString()

              activeSessions.push({
                dirName: c.dirName,
                projectShortName: shortName,
                fileName: c.fileName,
                sessionId: meta.sessionId || c.fileName.replace(".jsonl", ""),
                slug: meta.slug,
                model: meta.model,
                firstUserMessage: meta.firstUserMessage,
                lastUserMessage: meta.lastUserMessage,
                gitBranch: meta.gitBranch,
                cwd: meta.cwd,
                lastModified,
                turnCount: meta.turnCount,
                size: c.size,
                isActive: now - c.mtimeMs < 5 * 60 * 1000,
              })
            } catch {
              // skip inaccessible files
            }
          }

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify(activeSessions))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // GET /api/check-ports?ports=3000,5173 - check which ports are listening
      server.middlewares.use("/api/check-ports", async (req, res, next) => {
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

      // GET /api/background-tasks?cwd=<path> - scan Claude's task output directory for active background tasks
      server.middlewares.use("/api/background-tasks", async (req, res, next) => {
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

          // Convert CWD to the project hash format Claude uses
          // /Users/foo/Code/my-project → -Users-foo-Code-my-project
          const projectHash = cwd.replace(/\//g, "-").replace(/ /g, "-").replace(/@/g, "-").replace(/\./g, "-")
          const tasksDir = join(tmpBase, projectHash, "tasks")

          let files: string[]
          try {
            files = await readdir(tasksDir)
          } catch {
            // Tasks directory doesn't exist - no background tasks
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
              // Read up to 8KB from the file
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

            // Extract a clean preview (first meaningful lines)
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
          // If multiple tasks claim the same port, keep only the most recent one
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

      // POST /api/kill-port - kill process listening on a given port
      server.middlewares.use("/api/kill-port", (req, res, next) => {
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

            // Use lsof to find PIDs on this port, then kill them
            const child = spawn("lsof", [
              "-t",
              "-i",
              `:${port}`,
              "-sTCP:LISTEN",
            ])

            let stdout = ""
            child.stdout.on("data", (data: Buffer) => {
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

      // GET /api/find-session/:sessionId - find a session JSONL file by its session ID
      server.middlewares.use("/api/find-session/", async (req, res, next) => {
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

      // GET /api/team-member-session/:teamName/:memberName - find a team member's subagent session
      server.middlewares.use("/api/team-member-session/", async (req, res, next) => {
        if (req.method !== "GET") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const parts = url.pathname.split("/").filter(Boolean)
        if (parts.length !== 2) return next()

        const teamName = decodeURIComponent(parts[0])
        const memberName = decodeURIComponent(parts[1])

        try {
          // Read team config to get leadSessionId and member prompt
          const configPath = join(dirs.TEAMS_DIR, teamName, "config.json")
          const configRaw = await readFile(configPath, "utf-8")
          const config = JSON.parse(configRaw)

          const leadSessionId = config.leadSessionId
          if (!leadSessionId) {
            res.statusCode = 404
            res.end(JSON.stringify({ error: "No lead session ID" }))
            return
          }

          const member = config.members?.find(
            (m: { name: string }) => m.name === memberName
          )

          // If clicking the lead, return their session directly
          if (member?.agentType === "team-lead") {
            // Find lead's session file
            const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.name === "memory") continue
              const projectDir = join(dirs.PROJECTS_DIR, entry.name)
              try {
                const files = await readdir(projectDir)
                const targetFile = `${leadSessionId}.jsonl`
                if (files.includes(targetFile)) {
                  res.setHeader("Content-Type", "application/json")
                  res.end(JSON.stringify({ dirName: entry.name, fileName: targetFile }))
                  return
                }
              } catch { continue }
            }
            res.statusCode = 404
            res.end(JSON.stringify({ error: "Lead session not found" }))
            return
          }

          // For non-lead members, find their subagent session
          // Search for the lead session's subagent directory
          const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === "memory") continue
            const projectDir = join(dirs.PROJECTS_DIR, entry.name)
            const subagentDir = join(projectDir, leadSessionId, "subagents")

            let subagentFiles: string[]
            try {
              subagentFiles = (await readdir(subagentDir)).filter((f) =>
                f.endsWith(".jsonl")
              )
            } catch {
              continue
            }

            // Match subagent to member by checking if the initial prompt contains
            // the member's name or role description
            const memberPrompt = member?.prompt || ""
            const promptSnippet = memberPrompt.slice(0, 120)
            const searchTerms = [
              memberName,
              // Also try name with hyphens replaced (e.g. "security-reviewer" -> "security reviewer")
              memberName.replace(/-/g, " "),
              ...(promptSnippet
                ? [
                    promptSnippet,
                    // JSONL escapes quotes, so also try the escaped version
                    promptSnippet.replace(/"/g, '\\"'),
                  ]
                : []),
            ]

            for (const sf of subagentFiles) {
              try {
                const filePath = join(subagentDir, sf)
                // Read first line only (the spawn prompt) to avoid cross-contamination
                const fh = await open(filePath, "r")
                try {
                  const buf = Buffer.alloc(16384)
                  const { bytesRead } = await fh.read(buf, 0, 16384, 0)
                  const raw = buf.subarray(0, bytesRead).toString("utf-8")
                  // Only check the first JSONL line (the initial user message)
                  const firstLine = raw.split("\n")[0] || ""

                  // Check if this subagent matches the member
                  const matches = searchTerms.some((term) =>
                    firstLine.includes(term)
                  )
                  if (matches) {
                    // Return as a subagent path: dirName/leadSessionId/subagents/file
                    res.setHeader("Content-Type", "application/json")
                    res.end(
                      JSON.stringify({
                        dirName: entry.name,
                        fileName: `${leadSessionId}/subagents/${sf}`,
                      })
                    )
                    return
                  }
                } finally {
                  await fh.close()
                }
              } catch {
                continue
              }
            }
          }

          res.statusCode = 404
          res.end(JSON.stringify({ error: "Member session not found" }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // POST /api/send-message - send a message to a Claude session
      // Uses persistent processes to keep Anthropic prompt-cache warm.
      server.middlewares.use("/api/send-message", (req, res, next) => {
        if (req.method !== "POST") return next()

        let body = ""
        req.on("data", (chunk: string) => {
          body += chunk
        })
        req.on("end", () => {
          try {
            const { sessionId, message, images, cwd, permissions, model } = JSON.parse(body)

            if (!sessionId || (!message && (!images || images.length === 0))) {
              res.statusCode = 400
              res.end(
                JSON.stringify({ error: "sessionId and message or images are required" })
              )
              return
            }

            // Build permission args from config (falls back to YOLO)
            let permArgs: string[]
            if (permissions && typeof permissions.mode === "string" && permissions.mode !== "bypassPermissions") {
              permArgs = ["--permission-mode", permissions.mode]
              if (Array.isArray(permissions.allowedTools)) {
                for (const tool of permissions.allowedTools) {
                  permArgs.push("--allowedTools", tool)
                }
              }
              if (Array.isArray(permissions.disallowedTools)) {
                for (const tool of permissions.disallowedTools) {
                  permArgs.push("--disallowedTools", tool)
                }
              }
            } else {
              permArgs = ["--dangerously-skip-permissions"]
            }

            const modelArgs = model ? ["--model", model] : []

            // Build the stream-json user message (works for text and images)
            const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
            const contentBlocks: unknown[] = []
            if (Array.isArray(images)) {
              for (const img of images as Array<{ data: string; mediaType: string }>) {
                const mediaType = ALLOWED_IMAGE_TYPES.has(img.mediaType) ? img.mediaType : "image/png"
                contentBlocks.push({
                  type: "image",
                  source: { type: "base64", media_type: mediaType, data: img.data },
                })
              }
            }
            if (message) {
              contentBlocks.push({ type: "text", text: message })
            }
            const streamMsg = JSON.stringify({
              type: "user",
              message: { role: "user", content: contentBlocks },
            })

            // ── Try to reuse a persistent process ──────────────────────
            const existing = persistentSessions.get(sessionId)
            if (existing && !existing.dead) {
              // Persistent process is alive — send message to its stdin
              activeProcesses.set(sessionId, existing.proc)
              let responded = false
              existing.onResult = (result) => {
                if (responded) return
                responded = true
                activeProcesses.delete(sessionId)
                existing.onResult = null
                res.setHeader("Content-Type", "application/json")
                if (result.is_error) {
                  res.statusCode = 500
                  res.end(JSON.stringify({ error: result.result || "Claude returned an error" }))
                } else {
                  res.end(JSON.stringify({ success: true }))
                }
              }

              // If the process dies while waiting, respond with error
              const onDeath = () => {
                if (responded) return
                responded = true
                activeProcesses.delete(sessionId)
                existing.onResult = null
                res.statusCode = 500
                res.end(JSON.stringify({ error: "Claude process died unexpectedly" }))
              }
              existing.proc.once("close", onDeath)

              existing.proc.stdin!.write(streamMsg + "\n")
              return
            }

            // ── Spawn a new persistent process ─────────────────────────
            // Clean up stale entry if any
            if (existing) persistentSessions.delete(sessionId)

            const cleanEnv = { ...process.env }
            delete cleanEnv.CLAUDECODE

            const child = spawn(
              "claude",
              [
                "-p",
                "--input-format", "stream-json",
                "--output-format", "stream-json",
                "--verbose",
                "--resume", sessionId,
                ...permArgs,
                ...modelArgs,
              ],
              {
                cwd: cwd || homedir(),
                env: cleanEnv,
                stdio: ["pipe", "pipe", "pipe"],
              }
            )

            const ps: PersistentSession = {
              proc: child,
              onResult: null,
              dead: false,
              cwd: cwd || homedir(),
              permArgs,
              modelArgs,
              jsonlPath: null,
            }
            persistentSessions.set(sessionId, ps)
            activeProcesses.set(sessionId, child)

            // Resolve JSONL path asynchronously so we can forward progress events
            findJsonlPath(sessionId).then((p) => { ps.jsonlPath = p })

            // Read stdout line-by-line for result messages and progress forwarding
            const rl = createInterface({ input: child.stdout })
            rl.on("line", (line) => {
              try {
                const parsed = JSON.parse(line)
                if (parsed.type === "result" && ps.onResult) {
                  ps.onResult(parsed)
                }
                // Forward progress events to the JSONL so the SSE watcher picks them up.
                // In -p mode, Claude doesn't write progress entries to the JSONL itself,
                // but with --verbose --output-format stream-json it outputs them on stdout.
                // Only forward "progress" type — user/assistant messages are already
                // written to the JSONL by Claude directly.
                if (ps.jsonlPath && parsed.type === "progress") {
                  appendFile(ps.jsonlPath, line + "\n").catch(() => {})
                }
              } catch {
                // ignore non-JSON lines
              }
            })

            child.stderr.on("data", () => {
              // discard stderr (logged to JSONL by claude itself)
            })

            child.on("close", (code) => {
              ps.dead = true
              activeProcesses.delete(sessionId)
              persistentSessions.delete(sessionId)
              // If we were waiting for a result, respond now
              if (ps.onResult) {
                const wasKilled = code === null || code === 143 || code === 137
                ps.onResult({
                  type: "result",
                  subtype: wasKilled ? "success" : "error",
                  is_error: !wasKilled,
                  result: wasKilled ? undefined : `claude exited with code ${code}`,
                })
              }
            })

            child.on("error", (err) => {
              ps.dead = true
              activeProcesses.delete(sessionId)
              persistentSessions.delete(sessionId)
              if (ps.onResult) {
                ps.onResult({ type: "result", is_error: true, result: err.message })
              }
            })

            // Wire up result handler for this first message
            let responded = false
            ps.onResult = (result) => {
              if (responded) return
              responded = true
              activeProcesses.delete(sessionId)
              ps.onResult = null
              res.setHeader("Content-Type", "application/json")
              if (result.is_error) {
                res.statusCode = 500
                res.end(JSON.stringify({ error: result.result || "Claude returned an error" }))
              } else {
                res.end(JSON.stringify({ success: true }))
              }
            }

            // Send the first message
            child.stdin!.write(streamMsg + "\n")
          } catch {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "Invalid JSON body" }))
          }
        })
      })

      // POST /api/new-session - create a new Claude session in a project
      server.middlewares.use("/api/new-session", (req, res, next) => {
        if (req.method !== "POST") return next()

        let body = ""
        req.on("data", (chunk: string) => {
          body += chunk
        })
        req.on("end", async () => {
          try {
            const { dirName, message, permissions } = JSON.parse(body)

            if (!dirName || !message) {
              res.statusCode = 400
              res.end(
                JSON.stringify({ error: "dirName and message are required" })
              )
              return
            }

            const projectDir = join(dirs.PROJECTS_DIR, dirName)
            if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
              res.statusCode = 403
              res.end(JSON.stringify({ error: "Access denied" }))
              return
            }

            // Read the actual cwd from an existing session's JSONL (first line
            // contains the cwd field). The dirName encoding is lossy so we
            // can't reliably derive the filesystem path from it.
            let projectPath: string | null = null
            try {
              const files = await readdir(projectDir)
              for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
                try {
                  const fh = await open(join(projectDir, f), "r")
                  try {
                    const buf = Buffer.alloc(4096)
                    const { bytesRead } = await fh.read(buf, 0, 4096, 0)
                    const firstLine = buf.subarray(0, bytesRead).toString("utf-8").split("\n")[0]
                    if (firstLine) {
                      const parsed = JSON.parse(firstLine)
                      if (parsed.cwd) {
                        projectPath = parsed.cwd
                        break
                      }
                    }
                  } finally {
                    await fh.close()
                  }
                } catch {
                  continue
                }
              }
            } catch {
              // projectDir might not exist yet
            }
            if (!projectPath) {
              // Fallback: derive from dirName (lossy but better than nothing)
              projectPath = "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
            }

            // Build permission args
            let permArgs: string[]
            if (permissions && typeof permissions.mode === "string" && permissions.mode !== "bypassPermissions") {
              permArgs = ["--permission-mode", permissions.mode]
              if (Array.isArray(permissions.allowedTools)) {
                for (const tool of permissions.allowedTools) {
                  permArgs.push("--allowedTools", tool)
                }
              }
              if (Array.isArray(permissions.disallowedTools)) {
                for (const tool of permissions.disallowedTools) {
                  permArgs.push("--disallowedTools", tool)
                }
              }
            } else {
              permArgs = ["--dangerously-skip-permissions"]
            }

            // Generate a session ID upfront so we know the JSONL filename
            // and the session is registered in Claude's index (resumable).
            const sessionId = randomUUID()
            const fileName = `${sessionId}.jsonl`

            const cleanEnv = { ...process.env }
            delete cleanEnv.CLAUDECODE

            const child = spawn(
              "claude",
              ["-p", message, "--session-id", sessionId, ...permArgs],
              {
                cwd: projectPath,
                env: cleanEnv,
                stdio: ["ignore", "pipe", "pipe"],
              }
            )

            let stderr = ""
            child.stdout.on("data", () => {})
            child.stderr.on("data", (data: Buffer) => {
              stderr += data.toString()
            })

            activeProcesses.set(sessionId, child)
            child.on("close", () => {
              activeProcesses.delete(sessionId)
            })

            // Wait for the process to FINISH (not just for the file to appear).
            // If we respond as soon as the JSONL exists, the `-p` process is
            // still alive and holds a lock on the session.  A subsequent
            // `--resume` from send-message will fail because two processes
            // can't own the same session simultaneously.
            let responded = false
            const expectedPath = join(projectDir, fileName)

            const timeout = setTimeout(() => {
              if (!responded) {
                responded = true
                child.kill("SIGTERM")
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: stderr.trim() || "Timed out waiting for session to start",
                  })
                )
              }
            }, 60000) // 60s — the first turn may take a while

            child.on("error", (err) => {
              if (!responded) {
                responded = true
                clearTimeout(timeout)
                res.statusCode = 500
                res.end(JSON.stringify({ error: err.message }))
              }
            })

            child.on("close", async (code) => {
              if (responded) return
              responded = true
              clearTimeout(timeout)

              // Check if the session file was created
              try {
                await stat(expectedPath)
                res.setHeader("Content-Type", "application/json")
                res.end(
                  JSON.stringify({
                    success: true,
                    dirName,
                    fileName,
                    sessionId,
                  })
                )
              } catch {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error:
                      stderr.trim() ||
                      `claude exited with code ${code} before creating session`,
                  })
                )
              }
            })
          } catch {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "Invalid JSON body" }))
          }
        })
      })

      // POST /api/stop-session - stop a running claude child process
      server.middlewares.use("/api/stop-session", (req, res, next) => {
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
      server.middlewares.use("/api/kill-all", (req, res, next) => {
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
      server.middlewares.use("/api/running-processes", (req, res, next) => {
        if (req.method !== "GET") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const pathParts = url.pathname.split("/").filter(Boolean)
        if (pathParts.length > 0) return next()

        const child = spawn("ps", ["aux"])
        let stdout = ""
        child.stdout.on("data", (data: Buffer) => { stdout += data.toString() })
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

      // POST /api/kill-process - kill a specific process by PID
      server.middlewares.use("/api/kill-process", (req, res, next) => {
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

            // Also clean up from our tracked maps if this PID matches
            for (const [sid, ps] of persistentSessions) {
              if (ps.proc.pid === pid) {
                ps.dead = true
                persistentSessions.delete(sid)
                break
              }
            }
            for (const [sid, proc] of activeProcesses) {
              if (proc.pid === pid) {
                activeProcesses.delete(sid)
                break
              }
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

      // GET /api/session-team?leadSessionId=xxx[&subagentFile=xxx]
      // Detect if a session belongs to a team. Returns team config + current member name.
      server.middlewares.use("/api/session-team", async (req, res, next) => {
        if (req.method !== "GET") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const pathParts = url.pathname.split("/").filter(Boolean)
        if (pathParts.length > 0) return next()

        const leadSessionId = url.searchParams.get("leadSessionId")
        const subagentFile = url.searchParams.get("subagentFile")

        if (!leadSessionId) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "leadSessionId required" }))
          return
        }

        try {
          let teamDirs: string[]
          try {
            const entries = await readdir(dirs.TEAMS_DIR, { withFileTypes: true })
            teamDirs = entries
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
          } catch {
            res.statusCode = 404
            res.end(JSON.stringify({ error: "No teams directory" }))
            return
          }

          // Collect ALL matching teams, then pick the most recently created
          let bestMatch: { teamName: string; config: Record<string, unknown>; createdAt: number } | null = null

          for (const teamName of teamDirs) {
            try {
              const configPath = join(dirs.TEAMS_DIR, teamName, "config.json")
              const configRaw = await readFile(configPath, "utf-8")
              const config = JSON.parse(configRaw)

              if (config.leadSessionId !== leadSessionId) continue

              const createdAt = config.createdAt ?? 0
              if (!bestMatch || createdAt > bestMatch.createdAt) {
                bestMatch = { teamName, config, createdAt }
              }
            } catch {
              continue
            }
          }

          if (!bestMatch) {
            res.statusCode = 404
            res.end(JSON.stringify({ error: "No team found for this session" }))
            return
          }

          const { teamName: matchedTeamName, config: matchedConfig } = bestMatch
          let currentMemberName: string | null = null

          if (!subagentFile) {
            const lead = (matchedConfig.members as { agentType?: string; name?: string }[])?.find(
              (m) => m.agentType === "team-lead"
            )
            currentMemberName = lead?.name || null
          } else {
            currentMemberName = await matchSubagentToMember(
              leadSessionId,
              subagentFile,
              (matchedConfig.members as Array<{ name: string; agentType: string; prompt?: string }>) || []
            )
          }

          res.setHeader("Content-Type", "application/json")
          res.end(
            JSON.stringify({ teamName: matchedTeamName, config: matchedConfig, currentMemberName })
          )
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── Team API Endpoints ───────────────────────────────────────────────

      // GET /api/teams - list all teams with task progress summary
      server.middlewares.use("/api/teams", async (req, res, next) => {
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
      server.middlewares.use("/api/team-detail/", async (req, res, next) => {
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
      server.middlewares.use("/api/team-watch/", (req, res, next) => {
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
      server.middlewares.use("/api/team-message/", (req, res, next) => {
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

      // GET /api/task-output?path=<outputFile> - SSE stream of background task output
      server.middlewares.use("/api/task-output", (req, res, next) => {
        if (req.method !== "GET") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const pathParts = url.pathname.split("/").filter(Boolean)
        if (pathParts.length > 0) return next()

        const outputPath = url.searchParams.get("path")
        if (!outputPath) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "path query param required" }))
          return
        }

        // Security: only allow reading from /private/tmp/claude-* or /tmp/claude-*
        const resolved = resolve(outputPath)
        if (
          !resolved.startsWith("/private/tmp/claude-") &&
          !resolved.startsWith("/tmp/claude-")
        ) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied - only task output files allowed" }))
          return
        }

        // SSE headers
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })

        let offset = 0
        let debounceTimer: ReturnType<typeof setTimeout> | null = null
        let watcherReady = false

        // Read existing content first, then watch for changes
        async function readAndSend() {
          try {
            const s = await stat(resolved)
            if (s.size <= offset) return

            const fh = await open(resolved, "r")
            try {
              const buf = Buffer.alloc(s.size - offset)
              const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
              offset = s.size
              const text = buf.subarray(0, bytesRead).toString("utf-8")
              if (text) {
                res.write(`data: ${JSON.stringify({ type: "output", text })}\n\n`)
              }
            } finally {
              await fh.close()
            }
          } catch {
            // file may not exist yet or be temporarily unavailable
          }
        }

        // Initial read of existing content
        readAndSend().then(() => {
          watcherReady = true
        })

        // Watch for new content (file may not exist yet)
        let watcher: ReturnType<typeof watch> | null = null
        try {
          watcher = watch(resolved, () => {
            if (!watcherReady) return
            if (debounceTimer) clearTimeout(debounceTimer)
            debounceTimer = setTimeout(readAndSend, 100)
          })
          watcher.on("error", () => {}) // prevent uncaught crash when file is removed
        } catch {
          // file doesn't exist yet — poller below will pick up changes
        }

        // Also poll every 2s in case fs.watch misses events
        const poller = setInterval(readAndSend, 2000)

        const heartbeat = setInterval(() => {
          res.write(": heartbeat\n\n")
        }, 15000)

        req.on("close", () => {
          watcher?.close()
          if (debounceTimer) clearTimeout(debounceTimer)
          clearInterval(poller)
          clearInterval(heartbeat)
        })
      })

      // ── Undo/Redo API Endpoints ──────────────────────────────────────────

      // GET /api/undo-state/:sessionId - read undo state
      server.middlewares.use("/api/undo-state/", async (req, res, next) => {
        if (req.method !== "GET" && req.method !== "POST") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const parts = url.pathname.split("/").filter(Boolean)
        if (parts.length !== 1) return next()

        const sessionId = decodeURIComponent(parts[0])
        const filePath = join(dirs.UNDO_DIR, `${sessionId}.json`)

        if (req.method === "GET") {
          try {
            const content = await readFile(filePath, "utf-8")
            res.setHeader("Content-Type", "application/json")
            res.end(content)
          } catch {
            // Return 200 with null to avoid browser console noise from 404s
            res.setHeader("Content-Type", "application/json")
            res.end("null")
          }
          return
        }

        // POST - save undo state
        let body = ""
        req.on("data", (chunk: string) => { body += chunk })
        req.on("end", async () => {
          try {
            await mkdir(dirs.UNDO_DIR, { recursive: true })
            await writeFile(filePath, body, "utf-8")
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ success: true }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // POST /api/undo/apply - apply a batch of file operations (undo or redo)
      server.middlewares.use("/api/undo/apply", (req, res, next) => {
        if (req.method !== "POST") return next()

        let body = ""
        req.on("data", (chunk: string) => { body += chunk })
        req.on("end", async () => {
          try {
            const { operations } = JSON.parse(body) as {
              operations: Array<{
                type: "reverse-edit" | "delete-write" | "apply-edit" | "create-write"
                filePath: string
                oldString?: string
                newString?: string
                content?: string
              }>
            }

            if (!Array.isArray(operations) || operations.length === 0) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: "operations array required" }))
              return
            }

            // Validate all file paths are absolute and don't contain traversal
            for (const op of operations) {
              const resolved = resolve(op.filePath)
              if (resolved !== op.filePath) {
                res.statusCode = 403
                res.end(JSON.stringify({ error: `Invalid file path: ${op.filePath}` }))
                return
              }
            }

            // Track applied operations for rollback
            const applied: Array<{
              type: string
              filePath: string
              previousContent?: string
              fileExisted: boolean
            }> = []

            try {
              for (const op of operations) {
                if (op.type === "reverse-edit" || op.type === "apply-edit") {
                  // Read current file content
                  const content = await readFile(op.filePath, "utf-8")

                  // Verify exactly one occurrence of the expected string
                  if (op.oldString) {
                    const occurrences = content.split(op.oldString).length - 1
                    if (occurrences === 0) {
                      throw new Error(
                        `Conflict: expected string not found in ${op.filePath}. File may have been modified externally.`
                      )
                    }
                    if (occurrences > 1) {
                      throw new Error(
                        `Conflict: expected exactly 1 occurrence in ${op.filePath}, found ${occurrences}. Cannot safely apply edit.`
                      )
                    }
                  }

                  // Apply the edit (safe since we verified exactly one occurrence)
                  const updated = content.replace(op.oldString!, op.newString!)
                  applied.push({ type: op.type, filePath: op.filePath, previousContent: content, fileExisted: true })
                  await writeFile(op.filePath, updated, "utf-8")

                } else if (op.type === "delete-write") {
                  // Verify file content matches before deleting
                  let fileExisted = true
                  try {
                    const content = await readFile(op.filePath, "utf-8")
                    // Optional: verify content matches if provided
                    applied.push({ type: op.type, filePath: op.filePath, previousContent: content, fileExisted: true })
                  } catch {
                    fileExisted = false
                    applied.push({ type: op.type, filePath: op.filePath, fileExisted: false })
                  }
                  if (fileExisted) {
                    await unlink(op.filePath)
                  }

                } else if (op.type === "create-write") {
                  // Check if file already exists
                  let fileExisted = false
                  let previousContent: string | undefined
                  try {
                    previousContent = await readFile(op.filePath, "utf-8")
                    fileExisted = true
                  } catch {
                    fileExisted = false
                  }
                  applied.push({ type: op.type, filePath: op.filePath, previousContent, fileExisted })
                  await writeFile(op.filePath, op.content!, "utf-8")
                }
              }

              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ success: true, applied: applied.length }))

            } catch (err) {
              // Rollback all applied operations
              for (let i = applied.length - 1; i >= 0; i--) {
                const a = applied[i]
                try {
                  if (a.type === "reverse-edit" || a.type === "apply-edit") {
                    // Restore previous content
                    if (a.previousContent !== undefined) {
                      await writeFile(a.filePath, a.previousContent, "utf-8")
                    }
                  } else if (a.type === "delete-write") {
                    // Recreate the deleted file
                    if (a.previousContent !== undefined) {
                      await writeFile(a.filePath, a.previousContent, "utf-8")
                    }
                  } else if (a.type === "create-write") {
                    // Delete the created file or restore previous
                    if (a.fileExisted && a.previousContent !== undefined) {
                      await writeFile(a.filePath, a.previousContent, "utf-8")
                    } else if (!a.fileExisted) {
                      try { await unlink(a.filePath) } catch { /* file may not exist */ }
                    }
                  }
                } catch {
                  // Best-effort rollback
                }
              }

              res.statusCode = 409
              res.end(JSON.stringify({
                error: String(err instanceof Error ? err.message : err),
                rolledBack: applied.length,
              }))
            }
          } catch {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "Invalid JSON body" }))
          }
        })
      })

      // POST /api/undo/truncate-jsonl - remove lines from a JSONL file (for branching)
      server.middlewares.use("/api/undo/truncate-jsonl", (req, res, next) => {
        if (req.method !== "POST") return next()

        let body = ""
        req.on("data", (chunk: string) => { body += chunk })
        req.on("end", async () => {
          try {
            const { dirName, fileName, keepLines } = JSON.parse(body) as {
              dirName: string
              fileName: string
              keepLines: number
            }

            const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
            if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) {
              res.statusCode = 403
              res.end(JSON.stringify({ error: "Access denied" }))
              return
            }

            const content = await readFile(filePath, "utf-8")
            const lines = content.split("\n").filter(Boolean)

            if (keepLines >= lines.length) {
              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ success: true, removedLines: [] }))
              return
            }

            const removedLines = lines.slice(keepLines)
            const keptContent = lines.slice(0, keepLines).join("\n") + "\n"
            await writeFile(filePath, keptContent, "utf-8")

            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ success: true, removedLines }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // POST /api/undo/append-jsonl - append JSONL lines back to a file (for redo)
      server.middlewares.use("/api/undo/append-jsonl", (req, res, next) => {
        if (req.method !== "POST") return next()

        let body = ""
        req.on("data", (chunk: string) => { body += chunk })
        req.on("end", async () => {
          try {
            const { dirName, fileName, lines } = JSON.parse(body) as {
              dirName: string
              fileName: string
              lines: string[]
            }

            const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
            if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) {
              res.statusCode = 403
              res.end(JSON.stringify({ error: "Access denied" }))
              return
            }

            if (!Array.isArray(lines) || lines.length === 0) {
              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ success: true, appended: 0 }))
              return
            }

            const content = lines.join("\n") + "\n"
            await appendFile(filePath, content, "utf-8")

            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ success: true, appended: lines.length }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // POST /api/check-files-exist - check which files have been deleted + get line counts via git
      server.middlewares.use("/api/check-files-exist", (req, res, next) => {
        if (req.method !== "POST") return next()
        let body = ""
        req.on("data", (chunk: Buffer) => (body += chunk.toString()))
        req.on("end", async () => {
          try {
            const { files, dirs } = JSON.parse(body) as { files?: string[]; dirs?: string[] }
            const fileList = Array.isArray(files) ? files : []
            const dirList = Array.isArray(dirs) ? dirs : []
            if (fileList.length === 0 && dirList.length === 0) {
              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ deleted: [] }))
              return
            }
            const deleted: { path: string; lines: number }[] = []
            // Cache git root lookups per directory
            const gitRootCache = new Map<string, string | null>()

            async function findGitRoot(dir: string): Promise<string | null> {
              if (gitRootCache.has(dir)) return gitRootCache.get(dir)!
              // Walk up to find an existing directory (handles deleted dirs)
              let cwd = dir
              while (cwd && cwd !== "/") {
                try {
                  const s = await stat(cwd)
                  if (s.isDirectory()) break
                } catch {
                  cwd = cwd.substring(0, cwd.lastIndexOf("/")) || "/"
                }
              }
              return new Promise((resolve) => {
                const proc = spawn("git", ["rev-parse", "--show-toplevel"], { cwd })
                let out = ""
                proc.stdout.on("data", (d: Buffer) => (out += d.toString()))
                proc.on("close", (code) => {
                  const root = code === 0 ? out.trim() : null
                  gitRootCache.set(dir, root)
                  resolve(root)
                })
                proc.on("error", () => {
                  gitRootCache.set(dir, null)
                  resolve(null)
                })
              })
            }

            function spawnLines(args: string[], cwd: string): Promise<number> {
              return new Promise((resolve) => {
                const proc = spawn("git", args, { cwd })
                let out = ""
                proc.stdout.on("data", (d: Buffer) => (out += d.toString()))
                proc.on("close", (code) => {
                  if (code !== 0 || !out) return resolve(0)
                  resolve(out.split("\n").length)
                })
                proc.on("error", () => resolve(0))
              })
            }

            function spawnOutput(args: string[], cwd: string): Promise<string> {
              return new Promise((resolve) => {
                const proc = spawn("git", args, { cwd })
                let out = ""
                proc.stdout.on("data", (d: Buffer) => (out += d.toString()))
                proc.on("close", () => resolve(out.trim()))
                proc.on("error", () => resolve(""))
              })
            }

            async function getGitLineCount(filePath: string): Promise<number> {
              const dir = filePath.substring(0, filePath.lastIndexOf("/")) || "/"
              const gitRoot = await findGitRoot(dir)
              if (!gitRoot) return 0
              const relPath = filePath.startsWith(gitRoot + "/")
                ? filePath.slice(gitRoot.length + 1)
                : filePath

              // 1. Try HEAD (file still in current commit)
              const headLines = await spawnLines(["show", `HEAD:${relPath}`], gitRoot)
              if (headLines > 0) return headLines

              // 2. Find the commit that deleted the file, show from its parent
              const deleteCommit = await spawnOutput(
                ["log", "--diff-filter=D", "-1", "--format=%H", "--", relPath],
                gitRoot
              )
              if (deleteCommit) {
                const lines = await spawnLines(["show", `${deleteCommit}^:${relPath}`], gitRoot)
                if (lines > 0) return lines
              }

              // 3. Find any commit that last touched the file
              const lastCommit = await spawnOutput(
                ["log", "--all", "-1", "--format=%H", "--", relPath],
                gitRoot
              )
              if (lastCommit) {
                return await spawnLines(["show", `${lastCommit}:${relPath}`], gitRoot)
              }

              return 0
            }

            // Check individual files
            for (const f of fileList) {
              if (typeof f !== "string" || f.length === 0) continue
              try {
                await stat(f)
              } catch {
                const lines = await getGitLineCount(f)
                deleted.push({ path: f, lines })
              }
            }

            // Expand rm -rf directories: list files that were in the dir via git
            const seenPaths = new Set(deleted.map((d) => d.path))
            for (const d of dirList) {
              if (typeof d !== "string" || d.length === 0) continue
              // Skip dirs that still exist (not actually deleted)
              try {
                const s = await lstat(d)
                if (s.isDirectory()) continue
              } catch {
                // dir doesn't exist — expand via git
              }
              const parentDir = d.substring(0, d.lastIndexOf("/")) || "/"
              const gitRoot = await findGitRoot(parentDir)
              if (!gitRoot) continue
              const relDir = d.startsWith(gitRoot + "/")
                ? d.slice(gitRoot.length + 1)
                : d
              // List files that were in this directory across all commits
              const filesInDir = await spawnOutput(
                ["log", "--all", "--pretty=format:", "--name-only", "--diff-filter=ACMR", "--", `${relDir}/`],
                gitRoot
              )
              if (!filesInDir) continue
              const uniqueFiles = [...new Set(filesInDir.split("\n").map((l) => l.trim()).filter(Boolean))]
              for (const relFile of uniqueFiles) {
                const absFile = join(gitRoot, relFile)
                if (seenPaths.has(absFile)) continue
                // Verify it's actually deleted
                try {
                  await stat(absFile)
                  continue // still exists
                } catch {
                  // deleted
                }
                seenPaths.add(absFile)
                const lines = await getGitLineCount(absFile)
                deleted.push({ path: absFile, lines })
              }
            }

            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ deleted }))
          } catch {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: "Invalid JSON body" }))
          }
        })
      })

      // GET /api/watch/:dirName/:fileName - SSE stream of new JSONL lines
      server.middlewares.use("/api/watch/", (req, res, next) => {
        if (req.method !== "GET") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const parts = url.pathname.split("/").filter(Boolean)

        if (parts.length !== 2) return next()

        const dirName = decodeURIComponent(parts[0])
        const fileName = decodeURIComponent(parts[1])

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

        // SSE headers
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })

        let offset = 0
        let throttleTimer: ReturnType<typeof setTimeout> | null = null
        let trailingTimer: ReturnType<typeof setTimeout> | null = null
        let remainder = "" // partial line buffer
        const THROTTLE_MS = 150

        async function flushNewLines() {
          try {
            const s = await stat(filePath)
            if (s.size < offset) {
              // File was truncated (e.g. by undo). Reset to current size.
              // Client will reconnect via rawText dep change.
              offset = s.size
              remainder = ""
              return
            }
            if (s.size <= offset) {
              // No new bytes on disk, but remainder may hold a complete line
              // from a previous read that split mid-newline boundary.
              if (remainder) {
                try {
                  JSON.parse(remainder)
                  // It's valid JSON — treat it as a complete line
                  const line = remainder
                  remainder = ""
                  res.write(
                    `data: ${JSON.stringify({ type: "lines", lines: [line] })}\n\n`
                  )
                } catch {
                  // Not valid JSON yet — still a partial line, keep waiting
                }
              }
              return
            }

            const fh = await open(filePath, "r")
            try {
              const buf = Buffer.alloc(s.size - offset)
              const { bytesRead } = await fh.read(
                buf,
                0,
                buf.length,
                offset
              )
              offset = s.size

              const raw = remainder + buf.subarray(0, bytesRead).toString("utf-8")
              const parts = raw.split("\n")

              // Last element may be a partial line (no trailing \n)
              remainder = parts.pop() || ""

              const lines = parts.filter((l) => l.trim())
              if (lines.length > 0) {
                res.write(
                  `data: ${JSON.stringify({ type: "lines", lines })}\n\n`
                )
              }
            } finally {
              await fh.close()
            }
          } catch {
            // file temporarily unavailable during writes
          }
        }

        let watcher: ReturnType<typeof watch> | null = null
        let pollTimer: ReturnType<typeof setInterval> | null = null
        let heartbeat: ReturnType<typeof setInterval> | null = null
        let closed = false

        function cleanup() {
          closed = true
          watcher?.close()
          watcher = null
          if (throttleTimer) clearTimeout(throttleTimer)
          if (trailingTimer) clearTimeout(trailingTimer)
          if (pollTimer) clearInterval(pollTimer)
          if (heartbeat) clearInterval(heartbeat)
        }

        // Get initial file size, then start watching
        stat(filePath)
          .then((s) => {
            offset = s.size
            res.write(`data: ${JSON.stringify({ type: "init", offset })}\n\n`)
          })
          .catch(() => {
            res.write(
              `data: ${JSON.stringify({ type: "error", message: "File not found" })}\n\n`
            )
            cleanup()
            res.end()
          })

        // Throttle: fire immediately on first change, then at most once per
        // THROTTLE_MS while writes continue. A trailing flush catches the
        // final write after activity stops.
        try {
          watcher = watch(filePath, () => {
            if (closed) return
            // Schedule a trailing flush so the last write is never missed
            if (trailingTimer) clearTimeout(trailingTimer)
            trailingTimer = setTimeout(() => flushNewLines(), THROTTLE_MS)

            // Throttle: skip if a flush was recently scheduled
            if (throttleTimer) return
            // Fire immediately, then block further immediate fires for THROTTLE_MS
            flushNewLines()
            throttleTimer = setTimeout(() => {
              throttleTimer = null
            }, THROTTLE_MS)
          })
          watcher.on("error", () => {}) // prevent uncaught crash when file is removed
        } catch {
          // file may not exist yet — poller below will pick up changes
        }

        // Poll as a fallback for fs.watch — macOS FSEvents can coalesce
        // rapid writes (e.g. sub-agent progress events) into a single event
        // that was already handled, causing new data to be missed until the
        // next distinct file change.  A short poll interval catches these.
        const POLL_MS = 500
        pollTimer = setInterval(() => {
          if (!closed) flushNewLines()
        }, POLL_MS)

        // Heartbeat to keep connection alive
        heartbeat = setInterval(() => {
          if (!closed) res.write(": heartbeat\n\n")
        }, 15000)

        // Cleanup on disconnect
        req.on("close", cleanup)
      })
    },
  }
}
