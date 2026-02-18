/**
 * Standalone Express 5 + WebSocket server for the Electron build.
 *
 * Replicates every API endpoint from server/api-plugin.ts and the PTY
 * WebSocket handler from server/pty-plugin.ts so the app can run
 * without Vite's dev server.
 */

import type { ChildProcess } from "node:child_process"
import {
  readdir,
  readFile,
  writeFile,
  appendFile,
  stat,
  lstat,
  open,
  mkdir,
  unlink,
} from "node:fs/promises"
import { watch } from "node:fs"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { createServer } from "node:http"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import express from "express"
import { WebSocketServer, WebSocket } from "ws"
import { spawn as ptySpawn, type IPty } from "node-pty"

import {
  setConfigPath,
  getConfig,
  loadConfig,
  saveConfig,
  validateClaudeDir,
  getDirs,
} from "../server/config.ts"

// ── Helpers ────────────────────────────────────────────────────────────

function friendlySpawnError(err: NodeJS.ErrnoException): string {
  if (err.code === "ENOENT") {
    return "Claude CLI is not installed or not found in PATH. Install it with: npm install -g @anthropic-ai/claude-code"
  }
  return err.message
}

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
  const raw = dirName.replace(/^-/, "")
  const lowerRaw = raw.toLowerCase()

  let shortPart = raw
  const homePrefix = HOME_PREFIX + "-"
  if (lowerRaw.startsWith(homePrefix)) {
    const afterHome = raw.slice(homePrefix.length)
    const lowerAfter = afterHome.toLowerCase()
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
  let lines: string[]
  let isPartialRead = false
  const fileStat = await stat(filePath)

  if (fileStat.size > 65536) {
    const fh = await open(filePath, "r")
    try {
      const buf = Buffer.alloc(32768)
      const { bytesRead } = await fh.read(buf, 0, 32768, 0)
      const text = buf.subarray(0, bytesRead).toString("utf-8")
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
    turnCount,
    lineCount: isPartialRead ? Math.round(fileStat.size / (32768 / lines.length)) : lines.length,
  }
}

// Track active claude child processes by sessionId so we can stop them
const activeProcesses = new Map<string, ReturnType<typeof spawn>>()

// ── Persistent sessions ──────────────────────────────────────────────
interface PersistentSession {
  proc: ChildProcess
  onResult: ((msg: { type: string; subtype?: string; is_error?: boolean; result?: string }) => void) | null
  dead: boolean
  cwd: string
  permArgs: string[]
  modelArgs: string[]
  jsonlPath: string | null
}
const persistentSessions = new Map<string, PersistentSession>()

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

// ── PTY types ────────────────────────────────────────────────────────

interface PtySession {
  id: string
  pty: IPty
  name: string
  status: "running" | "exited"
  exitCode: number | null
  cols: number
  rows: number
  scrollback: string
  clients: Set<WebSocket>
  createdAt: number
  cwd: string
}

interface SessionInfo {
  id: string
  name: string
  status: "running" | "exited"
  exitCode: number | null
  createdAt: number
  cwd: string
}

function toSessionInfo(s: PtySession): SessionInfo {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    exitCode: s.exitCode,
    createdAt: s.createdAt,
    cwd: s.cwd,
  }
}

function broadcastToAll(wss: WebSocketServer, msg: object) {
  const data = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

function sendSessionList(wss: WebSocketServer, sessions: Map<string, PtySession>) {
  broadcastToAll(wss, {
    type: "sessions",
    sessions: Array.from(sessions.values()).map(toSessionInfo),
  })
}

// ── Main export ──────────────────────────────────────────────────────

export async function createAppServer(staticDir: string, userDataDir: string) {
  // Point config at the Electron userData directory
  setConfigPath(join(userDataDir, "config.local.json"))
  await loadConfig()
  refreshDirs()

  // Override UNDO_DIR to live in userData instead of the app bundle
  dirs.UNDO_DIR = join(userDataDir, "undo-history")

  const app = express()
  const httpServer = createServer(app)

  // ── Guard middleware: block data APIs when not configured ──────────
  app.use((req, res, next) => {
    const url = req.url || ""
    if (url.startsWith("/api/config")) return next()
    if (!url.startsWith("/api/")) return next()
    if (!getConfig()) {
      res.status(503).json({ error: "Not configured", code: "NOT_CONFIGURED" })
      return
    }
    refreshDirs()
    next()
  })

  // ── Config endpoints ──────────────────────────────────────────────

  // GET /api/config/validate?path=...
  app.use("/api/config/validate", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const dirPath = url.searchParams.get("path")

    if (!dirPath) {
      res.status(400).json({ valid: false, error: "path query param required" })
      return
    }

    const result = await validateClaudeDir(dirPath)
    res.json(result)
  })

  // GET /api/config - return current config (or null)
  // POST /api/config - validate and save config
  app.use("/api/config", async (req, res, next) => {
    if (req.method === "GET") {
      if (req.url && req.url !== "/" && req.url !== "" && !req.url.startsWith("?")) return next()
      const config = getConfig()
      res.json(config)
      return
    }

    if (req.method === "POST") {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", async () => {
        try {
          const { claudeDir } = JSON.parse(body)
          if (!claudeDir || typeof claudeDir !== "string") {
            res.status(400).json({ error: "claudeDir string required" })
            return
          }

          const validation = await validateClaudeDir(claudeDir)
          if (!validation.valid) {
            res.status(400).json({ error: validation.error })
            return
          }

          await saveConfig({ claudeDir: validation.resolved || claudeDir })
          refreshDirs()

          res.json({ success: true, claudeDir: validation.resolved || claudeDir })
        } catch {
          res.status(400).json({ error: "Invalid JSON body" })
        }
      })
      return
    }

    next()
  })

  // ── Projects & sessions ───────────────────────────────────────────

  // GET /api/projects
  app.use("/api/projects", async (_req, res, next) => {
    if (_req.method !== "GET") return next()
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

      projects.sort((a, b) => {
        if (!a.lastModified) return 1
        if (!b.lastModified) return -1
        return b.lastModified.localeCompare(a.lastModified)
      })

      res.json(projects)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/sessions/:dirName - list sessions
  // GET /api/sessions/:dirName/:sessionFile - serve file content
  app.use("/api/sessions/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length === 1) {
      const dirName = decodeURIComponent(parts[0])
      const projectDir = join(dirs.PROJECTS_DIR, dirName)

      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.status(403).json({ error: "Access denied" })
        return
      }

      try {
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10))
        const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)), 200)

        const files = await readdir(projectDir)
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"))

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

        fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

        const total = fileStats.length
        const start = (page - 1) * limit
        const paged = fileStats.slice(start, start + limit)

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

        res.json({ sessions, total, page, pageSize: limit })
      } catch (err) {
        res.status(500).json({ error: String(err) })
      }
    } else if (parts.length >= 2) {
      const dirName = decodeURIComponent(parts[0])
      const fileParts = parts.slice(1).map(decodeURIComponent)
      const fileName = fileParts.join("/")

      if (!fileName.endsWith(".jsonl")) {
        res.status(400).json({ error: "Only .jsonl files" })
        return
      }

      const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
      if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) {
        res.status(403).json({ error: "Access denied" })
        return
      }
      try {
        const content = await readFile(filePath, "utf-8")
        res.setHeader("Content-Type", "text/plain")
        res.end(content)
      } catch {
        res.status(404).json({ error: "File not found" })
      }
    } else {
      next()
    }
  })

  // GET /api/active-sessions
  app.use("/api/active-sessions", async (_req, res, next) => {
    if (_req.method !== "GET") return next()
    if (_req.url && !_req.url.startsWith("?") && _req.url !== "/" && _req.url !== "") return next()

    const url = new URL(_req.url || "/", "http://localhost")
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "30", 10), 100)

    try {
      const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })

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

      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const top = candidates.slice(0, limit)

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

      res.json(activeSessions)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/check-ports?ports=3000,5173
  app.use("/api/check-ports", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const portsParam = url.searchParams.get("ports")
    if (!portsParam) {
      res.status(400).json({ error: "ports query param required" })
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
          new Promise<void>((resolveP) => {
            const socket = createConnection({ port, host: "127.0.0.1" })
            socket.setTimeout(500)
            socket.on("connect", () => {
              results[port] = true
              socket.destroy()
              resolveP()
            })
            socket.on("timeout", () => {
              results[port] = false
              socket.destroy()
              resolveP()
            })
            socket.on("error", () => {
              results[port] = false
              resolveP()
            })
          })
      )
    )

    res.json(results)
  })

  // GET /api/background-tasks?cwd=<path>
  app.use("/api/background-tasks", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const cwd = url.searchParams.get("cwd")
    if (!cwd) {
      res.status(400).json({ error: "cwd query param required" })
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
        res.json([])
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

        try {
          const lstats = await lstat(fullPath)
          if (lstats.isSymbolicLink()) continue
        } catch { continue }

        const taskId = f.replace(".output", "")

        let content = ""
        let modifiedAt = 0
        try {
          const s = await stat(fullPath)
          modifiedAt = s.mtimeMs
          if (s.size === 0) continue
          const fh = await open(fullPath, "r")
          try {
            const buf = Buffer.alloc(Math.min(s.size, 8192))
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
            content = buf.subarray(0, bytesRead).toString("utf-8")
          } finally {
            await fh.close()
          }
        } catch { continue }

        const detectedPorts = new Set<number>()
        for (const m of content.matchAll(PORT_RE)) {
          const p = parseInt(m[1] || m[2] || m[3], 10)
          if (p > 0 && p < 65536) detectedPorts.add(p)
        }

        if (detectedPorts.size === 0) continue

        const contentLines = content.split("\n").filter((l) => l.trim() && !l.startsWith("[2K"))
        const preview = contentLines.slice(0, 5).join("\n").slice(0, 300)

        tasks.push({
          id: taskId,
          outputPath: fullPath,
          ports: [...detectedPorts],
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
            new Promise<void>((resolveP) => {
              const socket = createConnection({ port, host: "127.0.0.1" })
              socket.setTimeout(500)
              socket.on("connect", () => { portAlive[port] = true; socket.destroy(); resolveP() })
              socket.on("timeout", () => { portAlive[port] = false; socket.destroy(); resolveP() })
              socket.on("error", () => { portAlive[port] = false; resolveP() })
            })
        )
      )

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

      res.json(result)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /api/kill-port
  app.use("/api/kill-port", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const { port } = JSON.parse(body)
        if (!port || port < 1 || port > 65535) {
          res.status(400).json({ error: "Valid port required" })
          return
        }

        const child = spawn("lsof", ["-t", "-i", `:${port}`, "-sTCP:LISTEN"])

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
            res.json({ success: false, error: "No process found on port" })
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

          res.json({ success: true, killed, pids })
        })

        child.on("error", (err) => {
          res.status(500).json({ error: err.message })
        })
      } catch {
        res.status(400).json({ error: "Invalid JSON body" })
      }
    })
  })

  // GET /api/find-session/:sessionId
  app.use("/api/find-session/", async (req, res, next) => {
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
            res.json({ dirName: entry.name, fileName: targetFile })
            return
          }
        } catch {
          continue
        }
      }
      res.status(404).json({ error: "Session not found" })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/team-member-session/:teamName/:memberName
  app.use("/api/team-member-session/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 2) return next()

    const teamName = decodeURIComponent(parts[0])
    const memberName = decodeURIComponent(parts[1])

    try {
      const configPath = join(dirs.TEAMS_DIR, teamName, "config.json")
      const configRaw = await readFile(configPath, "utf-8")
      const config = JSON.parse(configRaw)

      const leadSessionId = config.leadSessionId
      if (!leadSessionId) {
        res.status(404).json({ error: "No lead session ID" })
        return
      }

      const member = config.members?.find(
        (m: { name: string }) => m.name === memberName
      )

      if (member?.agentType === "team-lead") {
        const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === "memory") continue
          const projectDir = join(dirs.PROJECTS_DIR, entry.name)
          try {
            const files = await readdir(projectDir)
            const targetFile = `${leadSessionId}.jsonl`
            if (files.includes(targetFile)) {
              res.json({ dirName: entry.name, fileName: targetFile })
              return
            }
          } catch { continue }
        }
        res.status(404).json({ error: "Lead session not found" })
        return
      }

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

        const memberPrompt = member?.prompt || ""
        const promptSnippet = memberPrompt.slice(0, 120)
        const searchTerms = [
          memberName,
          memberName.replace(/-/g, " "),
          ...(promptSnippet
            ? [
                promptSnippet,
                promptSnippet.replace(/"/g, '\\"'),
              ]
            : []),
        ]

        for (const sf of subagentFiles) {
          try {
            const filePath = join(subagentDir, sf)
            const fh = await open(filePath, "r")
            try {
              const buf = Buffer.alloc(16384)
              const { bytesRead } = await fh.read(buf, 0, 16384, 0)
              const raw = buf.subarray(0, bytesRead).toString("utf-8")
              const firstLine = raw.split("\n")[0] || ""

              const matches = searchTerms.some((term) =>
                firstLine.includes(term)
              )
              if (matches) {
                res.json({
                  dirName: entry.name,
                  fileName: `${leadSessionId}/subagents/${sf}`,
                })
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

      res.status(404).json({ error: "Member session not found" })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /api/send-message
  app.use("/api/send-message", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const { sessionId, message, images, cwd, permissions, model } = JSON.parse(body)

        if (!sessionId || (!message && (!images || images.length === 0))) {
          res.status(400).json({ error: "sessionId and message or images are required" })
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
          activeProcesses.set(sessionId, existing.proc)
          let responded = false
          existing.onResult = (result) => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            existing.onResult = null
            res.setHeader("Content-Type", "application/json")
            if (result.is_error) {
              res.status(500).json({ error: result.result || "Claude returned an error" })
            } else {
              res.json({ success: true })
            }
          }

          const onDeath = () => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            existing.onResult = null
            res.status(500).json({ error: "Claude process died unexpectedly" })
          }
          existing.proc.once("close", onDeath)

          existing.proc.stdin!.write(streamMsg + "\n")
          return
        }

        // ── Spawn a new persistent process ─────────────────────────
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

        findJsonlPath(sessionId).then((p) => { ps.jsonlPath = p })

        const rl = createInterface({ input: child.stdout! })
        rl.on("line", (line) => {
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === "result" && ps.onResult) {
              ps.onResult(parsed)
            }
            if (ps.jsonlPath && parsed.type === "progress") {
              appendFile(ps.jsonlPath, line + "\n").catch(() => {})
            }
          } catch {
            // ignore non-JSON lines
          }
        })

        let persistentStderr = ""
        child.stderr!.on("data", (data: Buffer) => {
          persistentStderr += data.toString()
        })

        child.on("close", (code) => {
          ps.dead = true
          activeProcesses.delete(sessionId)
          persistentSessions.delete(sessionId)
          if (ps.onResult) {
            const wasKilled = code === null || code === 143 || code === 137
            ps.onResult({
              type: "result",
              subtype: wasKilled ? "success" : "error",
              is_error: !wasKilled,
              result: wasKilled
                ? undefined
                : persistentStderr.trim() || `claude exited with code ${code}`,
            })
          }
        })

        child.on("error", (err: NodeJS.ErrnoException) => {
          ps.dead = true
          activeProcesses.delete(sessionId)
          persistentSessions.delete(sessionId)
          if (ps.onResult) {
            ps.onResult({ type: "result", is_error: true, result: friendlySpawnError(err) })
          }
        })

        let responded = false
        ps.onResult = (result) => {
          if (responded) return
          responded = true
          activeProcesses.delete(sessionId)
          ps.onResult = null
          res.setHeader("Content-Type", "application/json")
          if (result.is_error) {
            res.status(500).json({ error: result.result || "Claude returned an error" })
          } else {
            res.json({ success: true })
          }
        }

        child.stdin!.write(streamMsg + "\n")
      } catch {
        res.status(400).json({ error: "Invalid JSON body" })
      }
    })
  })

  // POST /api/new-session
  app.use("/api/new-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { dirName, message, permissions } = JSON.parse(body)

        if (!dirName || !message) {
          res.status(400).json({ error: "dirName and message are required" })
          return
        }

        const projectDir = join(dirs.PROJECTS_DIR, dirName)
        if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
          res.status(403).json({ error: "Access denied" })
          return
        }

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
          projectPath = "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
        }

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

        let responded = false
        const expectedPath = join(projectDir, fileName)

        const timeout = setTimeout(() => {
          if (!responded) {
            responded = true
            child.kill("SIGTERM")
            res.status(500).json({
              error: stderr.trim() || "Timed out waiting for session to start",
            })
          }
        }, 60000)

        child.on("error", (err: NodeJS.ErrnoException) => {
          if (!responded) {
            responded = true
            clearTimeout(timeout)
            res.status(500).json({ error: friendlySpawnError(err) })
          }
        })

        child.on("close", async (code) => {
          if (responded) return
          responded = true
          clearTimeout(timeout)

          try {
            await stat(expectedPath)
            res.json({ success: true, dirName, fileName, sessionId })
          } catch {
            res.status(500).json({
              error:
                stderr.trim() ||
                `claude exited with code ${code} before creating session`,
            })
          }
        })
      } catch {
        res.status(400).json({ error: "Invalid JSON body" })
      }
    })
  })

  // POST /api/stop-session
  app.use("/api/stop-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const { sessionId } = JSON.parse(body)

        if (!sessionId) {
          res.status(400).json({ error: "sessionId is required" })
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
          res.json({ success: false, error: "No active process for this session" })
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

        res.json({ success: true })
      } catch {
        res.status(400).json({ error: "Invalid JSON body" })
      }
    })
  })

  // POST /api/kill-all
  app.use("/api/kill-all", (req, res, next) => {
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

    res.json({ success: true, killed })
  })

  // GET /api/running-processes
  app.use("/api/running-processes", (req, res, next) => {
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

      processes.sort((a, b) => b.memMB - a.memMB)

      res.json(processes)
    })
    child.on("error", () => {
      res.status(500).json({ error: "Failed to list processes" })
    })
  })

  // POST /api/kill-process
  app.use("/api/kill-process", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", () => {
      try {
        const { pid } = JSON.parse(body)
        if (!pid || typeof pid !== "number" || pid < 2) {
          res.status(400).json({ error: "Valid pid required" })
          return
        }

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
          const forceKill = setTimeout(() => {
            try { process.kill(pid, "SIGKILL") } catch { /* already dead */ }
          }, 3000)
          forceKill.unref()

          res.json({ success: true, pid })
        } catch {
          res.status(404).json({ error: "Process not found or already dead" })
        }
      } catch {
        res.status(400).json({ error: "Invalid JSON body" })
      }
    })
  })

  // GET /api/session-team?leadSessionId=xxx[&subagentFile=xxx]
  app.use("/api/session-team", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const leadSessionId = url.searchParams.get("leadSessionId")
    const subagentFile = url.searchParams.get("subagentFile")

    if (!leadSessionId) {
      res.status(400).json({ error: "leadSessionId required" })
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
        res.status(404).json({ error: "No teams directory" })
        return
      }

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
        res.status(404).json({ error: "No team found for this session" })
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

      res.json({ teamName: matchedTeamName, config: matchedConfig, currentMemberName })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // ── Team API Endpoints ───────────────────────────────────────────────

  // GET /api/teams
  app.use("/api/teams", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    try {
      let teamDirs: string[]
      try {
        const entries = await readdir(dirs.TEAMS_DIR, { withFileTypes: true })
        teamDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      } catch {
        res.json([])
        return
      }

      const teams = []
      for (const teamName of teamDirs) {
        try {
          const configPath = join(dirs.TEAMS_DIR, teamName, "config.json")
          const configRaw = await readFile(configPath, "utf-8")
          const config = JSON.parse(configRaw)

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

      teams.sort((a, b) => b.createdAt - a.createdAt)

      res.json(teams)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/team-detail/:teamName
  app.use("/api/team-detail/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 1) return next()

    const teamName = decodeURIComponent(parts[0])
    const teamDir = join(dirs.TEAMS_DIR, teamName)

    if (!isWithinDir(dirs.TEAMS_DIR, teamDir)) {
      res.status(403).json({ error: "Access denied" })
      return
    }

    try {
      const configRaw = await readFile(join(teamDir, "config.json"), "utf-8")
      const config = JSON.parse(configRaw)

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

      res.json({ config, tasks, inboxes })
    } catch {
      res.status(404).json({ error: "Team not found" })
    }
  })

  // GET /api/team-watch/:teamName - SSE
  app.use("/api/team-watch/", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 1) return next()

    const teamName = decodeURIComponent(parts[0])
    const teamDir = join(dirs.TEAMS_DIR, teamName)
    const taskDir = join(dirs.TASKS_DIR, teamName)

    if (!isWithinDir(dirs.TEAMS_DIR, teamDir)) {
      res.status(403).json({ error: "Access denied" })
      return
    }

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

    const watchers: ReturnType<typeof watch>[] = []
    try {
      const w = watch(teamDir, { recursive: true }, sendUpdate)
      w.on("error", () => {})
      watchers.push(w)
    } catch { /* dir may not exist */ }
    try {
      const w = watch(taskDir, { recursive: true }, sendUpdate)
      w.on("error", () => {})
      watchers.push(w)
    } catch { /* dir may not exist */ }

    res.write(`data: ${JSON.stringify({ type: "init" })}\n\n`)

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n")
    }, 15000)

    req.on("close", () => {
      for (const w of watchers) w.close()
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(heartbeat)
    })
  })

  // POST /api/team-message/:teamName/:memberName
  app.use("/api/team-message/", (req, res, next) => {
    if (req.method !== "POST") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 2) return next()

    const teamName = decodeURIComponent(parts[0])
    const memberName = decodeURIComponent(parts[1])
    const inboxPath = join(dirs.TEAMS_DIR, teamName, "inboxes", `${memberName}.json`)

    if (!isWithinDir(dirs.TEAMS_DIR, inboxPath)) {
      res.status(403).json({ error: "Access denied" })
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
          res.status(400).json({ error: "message is required" })
          return
        }

        let inbox: unknown[] = []
        try {
          const raw = await readFile(inboxPath, "utf-8")
          inbox = JSON.parse(raw)
          if (!Array.isArray(inbox)) inbox = []
        } catch {
          // file doesn't exist yet, start with empty array
        }

        const newMsg = {
          from: "user",
          text: message,
          timestamp: new Date().toISOString(),
          color: undefined,
          read: false,
        }
        inbox.push(newMsg)

        await writeFile(inboxPath, JSON.stringify(inbox, null, 2), "utf-8")

        res.json({ success: true })
      } catch {
        res.status(400).json({ error: "Invalid JSON body" })
      }
    })
  })

  // GET /api/task-output?path=<outputFile> - SSE
  app.use("/api/task-output", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const outputPath = url.searchParams.get("path")
    if (!outputPath) {
      res.status(400).json({ error: "path query param required" })
      return
    }

    const resolved = resolve(outputPath)
    if (
      !resolved.startsWith("/private/tmp/claude-") &&
      !resolved.startsWith("/tmp/claude-")
    ) {
      res.status(403).json({ error: "Access denied - only task output files allowed" })
      return
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    let offset = 0
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let watcherReady = false

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

    readAndSend().then(() => {
      watcherReady = true
    })

    let watcher: ReturnType<typeof watch> | null = null
    try {
      watcher = watch(resolved, () => {
        if (!watcherReady) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(readAndSend, 100)
      })
      watcher.on("error", () => {})
    } catch {
      // file doesn't exist yet — poller below will pick up changes
    }

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

  // GET/POST /api/undo-state/:sessionId
  app.use("/api/undo-state/", async (req, res, next) => {
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
        res.json({ success: true })
      } catch (err) {
        res.status(500).json({ error: String(err) })
      }
    })
  })

  // POST /api/undo/apply
  app.use("/api/undo/apply", (req, res, next) => {
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
          res.status(400).json({ error: "operations array required" })
          return
        }

        for (const op of operations) {
          const resolvedPath = resolve(op.filePath)
          if (resolvedPath !== op.filePath) {
            res.status(403).json({ error: `Invalid file path: ${op.filePath}` })
            return
          }
        }

        const applied: Array<{
          type: string
          filePath: string
          previousContent?: string
          fileExisted: boolean
        }> = []

        try {
          for (const op of operations) {
            if (op.type === "reverse-edit" || op.type === "apply-edit") {
              const content = await readFile(op.filePath, "utf-8")

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

              const updated = content.replace(op.oldString!, op.newString!)
              applied.push({ type: op.type, filePath: op.filePath, previousContent: content, fileExisted: true })
              await writeFile(op.filePath, updated, "utf-8")

            } else if (op.type === "delete-write") {
              let fileExisted = true
              try {
                const content = await readFile(op.filePath, "utf-8")
                applied.push({ type: op.type, filePath: op.filePath, previousContent: content, fileExisted: true })
              } catch {
                fileExisted = false
                applied.push({ type: op.type, filePath: op.filePath, fileExisted: false })
              }
              if (fileExisted) {
                await unlink(op.filePath)
              }

            } else if (op.type === "create-write") {
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

          res.json({ success: true, applied: applied.length })

        } catch (err) {
          // Rollback all applied operations
          for (let i = applied.length - 1; i >= 0; i--) {
            const a = applied[i]
            try {
              if (a.type === "reverse-edit" || a.type === "apply-edit") {
                if (a.previousContent !== undefined) {
                  await writeFile(a.filePath, a.previousContent, "utf-8")
                }
              } else if (a.type === "delete-write") {
                if (a.previousContent !== undefined) {
                  await writeFile(a.filePath, a.previousContent, "utf-8")
                }
              } else if (a.type === "create-write") {
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

          res.status(409).json({
            error: String(err instanceof Error ? err.message : err),
            rolledBack: applied.length,
          })
        }
      } catch {
        res.status(400).json({ error: "Invalid JSON body" })
      }
    })
  })

  // POST /api/undo/truncate-jsonl
  app.use("/api/undo/truncate-jsonl", (req, res, next) => {
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
          res.status(403).json({ error: "Access denied" })
          return
        }

        const content = await readFile(filePath, "utf-8")
        const lines = content.split("\n").filter(Boolean)

        if (keepLines >= lines.length) {
          res.json({ success: true, removedLines: [] })
          return
        }

        const removedLines = lines.slice(keepLines)
        const keptContent = lines.slice(0, keepLines).join("\n") + "\n"
        await writeFile(filePath, keptContent, "utf-8")

        res.json({ success: true, removedLines })
      } catch (err) {
        res.status(500).json({ error: String(err) })
      }
    })
  })

  // POST /api/undo/append-jsonl
  app.use("/api/undo/append-jsonl", (req, res, next) => {
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
          res.status(403).json({ error: "Access denied" })
          return
        }

        if (!Array.isArray(lines) || lines.length === 0) {
          res.json({ success: true, appended: 0 })
          return
        }

        const content = lines.join("\n") + "\n"
        await appendFile(filePath, content, "utf-8")

        res.json({ success: true, appended: lines.length })
      } catch (err) {
        res.status(500).json({ error: String(err) })
      }
    })
  })

  // POST /api/check-files-exist
  app.use("/api/check-files-exist", (req, res, next) => {
    if (req.method !== "POST") return next()
    let body = ""
    req.on("data", (chunk: Buffer) => (body += chunk.toString()))
    req.on("end", async () => {
      try {
        const { files, dirs: dirsList } = JSON.parse(body) as { files?: string[]; dirs?: string[] }
        const fileList = Array.isArray(files) ? files : []
        const dirList = Array.isArray(dirsList) ? dirsList : []
        if (fileList.length === 0 && dirList.length === 0) {
          res.json({ deleted: [] })
          return
        }
        const deleted: { path: string; lines: number }[] = []
        const gitRootCache = new Map<string, string | null>()

        async function findGitRoot(dir: string): Promise<string | null> {
          if (gitRootCache.has(dir)) return gitRootCache.get(dir)!
          let cwd = dir
          while (cwd && cwd !== "/") {
            try {
              const s = await stat(cwd)
              if (s.isDirectory()) break
            } catch {
              cwd = cwd.substring(0, cwd.lastIndexOf("/")) || "/"
            }
          }
          return new Promise((resolveP) => {
            const proc = spawn("git", ["rev-parse", "--show-toplevel"], { cwd })
            let out = ""
            proc.stdout.on("data", (d: Buffer) => (out += d.toString()))
            proc.on("close", (code) => {
              const root = code === 0 ? out.trim() : null
              gitRootCache.set(dir, root)
              resolveP(root)
            })
            proc.on("error", () => {
              gitRootCache.set(dir, null)
              resolveP(null)
            })
          })
        }

        function spawnLines(args: string[], cwd: string): Promise<number> {
          return new Promise((resolveP) => {
            const proc = spawn("git", args, { cwd })
            let out = ""
            proc.stdout.on("data", (d: Buffer) => (out += d.toString()))
            proc.on("close", (code) => {
              if (code !== 0 || !out) return resolveP(0)
              resolveP(out.split("\n").length)
            })
            proc.on("error", () => resolveP(0))
          })
        }

        function spawnOutput(args: string[], cwd: string): Promise<string> {
          return new Promise((resolveP) => {
            const proc = spawn("git", args, { cwd })
            let out = ""
            proc.stdout.on("data", (d: Buffer) => (out += d.toString()))
            proc.on("close", () => resolveP(out.trim()))
            proc.on("error", () => resolveP(""))
          })
        }

        async function getGitLineCount(filePath: string): Promise<number> {
          const dir = filePath.substring(0, filePath.lastIndexOf("/")) || "/"
          const gitRoot = await findGitRoot(dir)
          if (!gitRoot) return 0
          const relPath = filePath.startsWith(gitRoot + "/")
            ? filePath.slice(gitRoot.length + 1)
            : filePath

          const headLines = await spawnLines(["show", `HEAD:${relPath}`], gitRoot)
          if (headLines > 0) return headLines

          const deleteCommit = await spawnOutput(
            ["log", "--diff-filter=D", "-1", "--format=%H", "--", relPath],
            gitRoot
          )
          if (deleteCommit) {
            const lineCount = await spawnLines(["show", `${deleteCommit}^:${relPath}`], gitRoot)
            if (lineCount > 0) return lineCount
          }

          const lastCommit = await spawnOutput(
            ["log", "--all", "-1", "--format=%H", "--", relPath],
            gitRoot
          )
          if (lastCommit) {
            return await spawnLines(["show", `${lastCommit}:${relPath}`], gitRoot)
          }

          return 0
        }

        for (const f of fileList) {
          if (typeof f !== "string" || f.length === 0) continue
          try {
            await stat(f)
          } catch {
            const lineCount = await getGitLineCount(f)
            deleted.push({ path: f, lines: lineCount })
          }
        }

        const seenPaths = new Set(deleted.map((d) => d.path))
        for (const d of dirList) {
          if (typeof d !== "string" || d.length === 0) continue
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
          const filesInDir = await spawnOutput(
            ["log", "--all", "--pretty=format:", "--name-only", "--diff-filter=ACMR", "--", `${relDir}/`],
            gitRoot
          )
          if (!filesInDir) continue
          const uniqueFiles = [...new Set(filesInDir.split("\n").map((l) => l.trim()).filter(Boolean))]
          for (const relFile of uniqueFiles) {
            const absFile = join(gitRoot, relFile)
            if (seenPaths.has(absFile)) continue
            try {
              await stat(absFile)
              continue // still exists
            } catch {
              // deleted
            }
            seenPaths.add(absFile)
            const lineCount = await getGitLineCount(absFile)
            deleted.push({ path: absFile, lines: lineCount })
          }
        }

        res.json({ deleted })
      } catch {
        res.status(400).json({ error: "Invalid JSON body" })
      }
    })
  })

  // GET /api/watch/:dirName/:fileName - SSE stream of new JSONL lines
  app.use("/api/watch/", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 2) return next()

    const dirName = decodeURIComponent(parts[0])
    const fileName = decodeURIComponent(parts[1])

    if (!fileName.endsWith(".jsonl")) {
      res.status(400).json({ error: "Only .jsonl files" })
      return
    }

    const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
    if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) {
      res.status(403).json({ error: "Access denied" })
      return
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    let offset = 0
    let throttleTimer: ReturnType<typeof setTimeout> | null = null
    let trailingTimer: ReturnType<typeof setTimeout> | null = null
    let remainder = ""
    const THROTTLE_MS = 150

    async function flushNewLines() {
      try {
        const s = await stat(filePath)
        if (s.size < offset) {
          offset = s.size
          remainder = ""
          return
        }
        if (s.size <= offset) {
          if (remainder) {
            try {
              JSON.parse(remainder)
              const line = remainder
              remainder = ""
              res.write(
                `data: ${JSON.stringify({ type: "lines", lines: [line] })}\n\n`
              )
            } catch {
              // Not valid JSON yet — still a partial line
            }
          }
          return
        }

        const fh = await open(filePath, "r")
        try {
          const buf = Buffer.alloc(s.size - offset)
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
          offset = s.size

          const raw = remainder + buf.subarray(0, bytesRead).toString("utf-8")
          const rawParts = raw.split("\n")

          remainder = rawParts.pop() || ""

          const lines = rawParts.filter((l) => l.trim())
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

    try {
      watcher = watch(filePath, () => {
        if (closed) return
        if (trailingTimer) clearTimeout(trailingTimer)
        trailingTimer = setTimeout(() => flushNewLines(), THROTTLE_MS)

        if (throttleTimer) return
        flushNewLines()
        throttleTimer = setTimeout(() => {
          throttleTimer = null
        }, THROTTLE_MS)
      })
      watcher.on("error", () => {})
    } catch {
      // file may not exist yet — poller below will pick up changes
    }

    const POLL_MS = 500
    pollTimer = setInterval(() => {
      if (!closed) flushNewLines()
    }, POLL_MS)

    heartbeat = setInterval(() => {
      if (!closed) res.write(": heartbeat\n\n")
    }, 15000)

    req.on("close", cleanup)
  })

  // ── Static files & SPA fallback ──────────────────────────────────────
  app.use(express.static(staticDir))
  app.get("*", (_req, res) => {
    res.sendFile(join(staticDir, "index.html"))
  })

  // ── PTY WebSocket handler ────────────────────────────────────────────
  const ptySessions = new Map<string, PtySession>()
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url || "/", "http://localhost")
      if (url.pathname !== "/__pty") return

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req)
      })
    }
  )

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        handleMessage(ws, msg)
      } catch {
        ws.send(JSON.stringify({ type: "error", id: "", message: "Invalid JSON" }))
      }
    })

    ws.on("close", () => {
      for (const session of ptySessions.values()) {
        session.clients.delete(ws)
      }
    })
  })

  function handleMessage(ws: WebSocket, msg: Record<string, unknown>) {
    switch (msg.type) {
      case "spawn":
        handleSpawn(ws, msg)
        break
      case "input":
        handleInput(msg)
        break
      case "resize":
        handleResize(msg)
        break
      case "kill":
        handleKill(msg)
        break
      case "attach":
        handleAttach(ws, msg)
        break
      case "list":
        ws.send(
          JSON.stringify({
            type: "sessions",
            sessions: Array.from(ptySessions.values()).map(toSessionInfo),
          })
        )
        break
      case "rename":
        handleRename(msg)
        break
    }
  }

  function handleSpawn(ws: WebSocket, msg: Record<string, unknown>) {
    const id = (msg.id as string) || randomUUID()
    const name = (msg.name as string) || `Terminal ${ptySessions.size + 1}`
    const cwd = (msg.cwd as string) || homedir()
    const cols = (msg.cols as number) || 80
    const rows = (msg.rows as number) || 24
    const command = (msg.command as string) || process.env.SHELL || "/bin/zsh"
    const args = (msg.args as string[]) || []

    let pty: IPty
    try {
      pty = ptySpawn(command, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      })
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          id,
          message: `Failed to spawn PTY: ${err}`,
        })
      )
      return
    }

    const session: PtySession = {
      id,
      pty,
      name,
      status: "running",
      exitCode: null,
      cols,
      rows,
      scrollback: "",
      clients: new Set([ws]),
      createdAt: Date.now(),
      cwd,
    }

    pty.onData((data: string) => {
      session.scrollback += data
      if (session.scrollback.length > 50_000) {
        session.scrollback = session.scrollback.slice(-40_000)
      }
      const out = JSON.stringify({ type: "output", id, data })
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(out)
        }
      }
    })

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = "exited"
      session.exitCode = exitCode
      const exitMsg = JSON.stringify({ type: "exit", id, code: exitCode })
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(exitMsg)
        }
      }
      sendSessionList(wss, ptySessions)
    })

    ptySessions.set(id, session)
    ws.send(JSON.stringify({ type: "spawned", id, name }))
    sendSessionList(wss, ptySessions)
  }

  function handleInput(msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (session?.status === "running") {
      session.pty.write(msg.data as string)
    }
  }

  function handleResize(msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (session?.status === "running") {
      const cols = msg.cols as number
      const rows = msg.rows as number
      session.pty.resize(cols, rows)
      session.cols = cols
      session.rows = rows
    }
  }

  function handleKill(msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (session) {
      if (session.status === "running") {
        session.pty.kill()
      }
      ptySessions.delete(msg.id as string)
      sendSessionList(wss, ptySessions)
    }
  }

  function handleAttach(ws: WebSocket, msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (!session) {
      ws.send(
        JSON.stringify({
          type: "error",
          id: msg.id,
          message: "Session not found",
        })
      )
      return
    }
    session.clients.add(ws)
    if (session.scrollback.length > 0) {
      ws.send(
        JSON.stringify({
          type: "output",
          id: msg.id,
          data: session.scrollback,
        })
      )
    }
    if (session.status === "exited") {
      ws.send(
        JSON.stringify({
          type: "exit",
          id: msg.id,
          code: session.exitCode,
        })
      )
    }
  }

  function handleRename(msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (session) {
      session.name = msg.name as string
      sendSessionList(wss, ptySessions)
    }
  }

  // Cleanup on server close
  httpServer.on("close", () => {
    // Kill all API child processes
    for (const [sid, proc] of activeProcesses) {
      try { proc.kill("SIGTERM") } catch { /* already dead */ }
      activeProcesses.delete(sid)
    }
    for (const [sid, ps] of persistentSessions) {
      try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
      persistentSessions.delete(sid)
    }
    // Kill all PTY sessions
    for (const session of ptySessions.values()) {
      if (session.status === "running") {
        session.pty.kill()
      }
    }
    ptySessions.clear()
  })

  return { httpServer }
}
