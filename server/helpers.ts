import type { ChildProcess } from "node:child_process"
import { readdir, readFile, stat, open } from "node:fs/promises"
import { join } from "node:path"
import { resolve } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { appendFile } from "node:fs/promises"
import { watch } from "node:fs"
import { timingSafeEqual, randomBytes, createHash } from "node:crypto"
import { randomUUID } from "node:crypto"

import { getConfig, getDirs } from "./config"

// ── Shared types ────────────────────────────────────────────────────────

import type { IncomingMessage, ServerResponse } from "node:http"

export type NextFn = (err?: unknown) => void
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: NextFn) => void
export type UseFn = (path: string, handler: Middleware) => void

// ── Friendly error formatter ────────────────────────────────────────────

export function friendlySpawnError(err: NodeJS.ErrnoException): string {
  if (err.code === "ENOENT") {
    return "Claude CLI is not installed or not found in PATH. Install it with: npm install -g @anthropic-ai/claude-code"
  }
  return err.message
}

// ── Mutable directory references ────────────────────────────────────────

export const dirs = {
  PROJECTS_DIR: "",
  TEAMS_DIR: "",
  TASKS_DIR: "",
  UNDO_DIR: "",
}

export function refreshDirs(): boolean {
  const config = getConfig()
  if (!config) return false
  const d = getDirs(config.claudeDir)
  dirs.PROJECTS_DIR = d.PROJECTS_DIR
  dirs.TEAMS_DIR = d.TEAMS_DIR
  dirs.TASKS_DIR = d.TASKS_DIR
  dirs.UNDO_DIR = d.UNDO_DIR
  return true
}

// ── Path safety ─────────────────────────────────────────────────────────

export function isWithinDir(parent: string, child: string): boolean {
  const resolved = resolve(child)
  return resolved.startsWith(resolve(parent) + "/") || resolved === resolve(parent)
}

// ── Network auth ────────────────────────────────────────────────────────

const LOCAL_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export function isLocalRequest(req: IncomingMessage): boolean {
  return LOCAL_ADDRS.has(req.socket.remoteAddress || "")
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

// ── Rate limiting ────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = 60_000  // 1 minute
const RATE_LIMIT_MAX_ATTEMPTS = 5    // 5 attempts per window

function getRateLimitKey(req: IncomingMessage): string {
  return req.socket.remoteAddress || "unknown"
}

export function isRateLimited(req: IncomingMessage): boolean {
  const key = getRateLimitKey(req)
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count++
  if (entry.count > RATE_LIMIT_MAX_ATTEMPTS) return true
  return false
}

// Periodically clean up expired entries (unref so build process can exit)
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, 60_000).unref()

// ── Session token system ────────────────────────────────────────────────

interface SessionInfo {
  createdAt: number
  ip: string
  userAgent: string
  lastActivity: number
}

const activeSessions = new Map<string, SessionInfo>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export function createSessionToken(ip: string, userAgent?: string): string {
  const token = randomBytes(32).toString("hex")
  const now = Date.now()
  activeSessions.set(token, { createdAt: now, ip, userAgent: userAgent || "", lastActivity: now })
  return token
}

export function validateSessionToken(token: string): boolean {
  const session = activeSessions.get(token)
  if (!session) return false
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    activeSessions.delete(token)
    return false
  }
  session.lastActivity = Date.now()
  return true
}

export function revokeAllSessions(): void {
  activeSessions.clear()
}

export function getConnectedDevices(): Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }> {
  const now = Date.now()
  const devices: Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }> = []
  for (const [, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) continue
    devices.push({
      ip: session.ip.replace(/^::ffff:/, ""),
      userAgent: session.userAgent,
      deviceName: parseDeviceName(session.userAgent),
      connectedAt: session.createdAt,
      lastActivity: session.lastActivity,
    })
  }
  return devices
}

function parseDeviceName(ua: string): string {
  if (!ua) return "Unknown device"
  // iOS devices
  if (/iPhone/.test(ua)) return "iPhone"
  if (/iPad/.test(ua)) return "iPad"
  // macOS
  if (/Macintosh|Mac OS/.test(ua)) return "Mac"
  // Windows
  if (/Windows/.test(ua)) return "Windows PC"
  // Android
  if (/Android/.test(ua)) {
    const match = ua.match(/;\s*([^;)]+)\s*Build\//)
    if (match) return match[1].trim()
    return "Android device"
  }
  // Linux
  if (/Linux/.test(ua)) return "Linux"
  return "Unknown device"
}

// Clean up expired sessions periodically (unref so build process can exit)
setInterval(() => {
  const now = Date.now()
  for (const [token, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) activeSessions.delete(token)
  }
}, 60_000).unref()

// ── Password hashing ────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = createHash("sha256").update(salt + password).digest("hex")
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  // Support legacy unhashed passwords (no colon = plaintext)
  if (!stored.includes(":")) {
    return safeCompare(password, stored)
  }
  const [salt, hash] = stored.split(":")
  const candidate = createHash("sha256").update(salt + password).digest("hex")
  return safeCompare(candidate, hash)
}

// ── Password validation ─────────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 12

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  return null
}

// ── Security headers middleware ──────────────────────────────────────────

export function securityHeaders(_req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")
  res.setHeader("X-XSS-Protection", "1; mode=block")
  // Cross-Origin Isolation — required for SharedArrayBuffer (Whisper WASM voice input)
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless")
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  next()
}

// ── Body size limit ─────────────────────────────────────────────────────

const MAX_BODY_SIZE = 5 * 1024 * 1024 // 5MB

export function bodySizeLimit(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return next()

  let size = 0
  const contentLength = parseInt(req.headers["content-length"] || "", 10)
  if (contentLength > MAX_BODY_SIZE) {
    res.statusCode = 413
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Request body too large" }))
    return
  }

  const origOn = req.on.bind(req)
  req.on = function (event: string, listener: (...args: unknown[]) => void) {
    if (event === "data") {
      const wrapped = (chunk: Buffer | string) => {
        size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
        if (size > MAX_BODY_SIZE) {
          res.statusCode = 413
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Request body too large" }))
          req.destroy()
          return
        }
        ;(listener as (chunk: Buffer | string) => void)(chunk)
      }
      return origOn(event, wrapped)
    }
    return origOn(event, listener)
  } as typeof req.on

  next()
}

// ── Auth middleware ──────────────────────────────────────────────────────

// Paths that remote clients can access without auth (login page assets + verify endpoint)
const PUBLIC_PATHS = new Set(["/api/auth/verify"])

function isPublicPath(url: string): boolean {
  if (PUBLIC_PATHS.has(url.split("?")[0])) return true
  // Allow static assets so the login screen can load
  if (!url.startsWith("/api/") && !url.startsWith("/__pty")) return true
  return false
}

export function authMiddleware(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  if (isLocalRequest(req)) return next()
  if (isPublicPath(req.url || "/")) return next()

  const config = getConfig()
  if (!config?.networkAccess || !config?.networkPassword) {
    res.statusCode = 403
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Network access is disabled" }))
    return
  }

  const authHeader = req.headers.authorization
  let token: string | null = null
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7)
  } else {
    const url = new URL(req.url || "/", "http://localhost")
    token = url.searchParams.get("token")
  }

  if (!token || !validateSessionToken(token)) {
    res.statusCode = 401
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Authentication required" }))
    return
  }

  next()
}

// ── Subagent matching ───────────────────────────────────────────────────

export async function matchSubagentToMember(
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

// ── Project name helpers ────────────────────────────────────────────────

const HOME_PREFIX = homedir().replace(/\//g, "-").replace(/^-/, "").toLowerCase()

export function projectDirToReadableName(dirName: string): { path: string; shortName: string } {
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

// ── Session metadata extraction ─────────────────────────────────────────

export async function getSessionMeta(filePath: string) {
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
  let branchedFrom: { sessionId: string; turnIndex?: number | null } | undefined

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId
      if (obj.version && !version) version = obj.version
      if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch
      if (obj.slug && !slug) slug = obj.slug
      if (obj.cwd && !cwd) cwd = obj.cwd
      if (obj.branchedFrom && !branchedFrom) branchedFrom = obj.branchedFrom
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
    branchedFrom,
  }
}

/**
 * Search all user messages in a session file for a query string.
 * Returns the first matching message snippet, or null if no match.
 */
export async function searchSessionMessages(
  filePath: string,
  query: string
): Promise<string | null> {
  const q = query.toLowerCase()

  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch {
    return null
  }

  const lines = content.split("\n")
  for (const line of lines) {
    // Fast pre-check: skip lines that can't be user messages
    if (!line || !line.includes('"user"')) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type !== "user" || obj.isMeta) continue

      const c = obj.message?.content
      let text = ""
      if (typeof c === "string") {
        text = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block.type === "text") {
            text += block.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim() + " "
          }
        }
        text = text.trim()
      }

      const lower = text.toLowerCase()
      if (lower.includes(q)) {
        const idx = lower.indexOf(q)
        const start = Math.max(0, idx - 30)
        const end = Math.min(text.length, idx + query.length + 70)
        const snippet = (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "")
        return snippet.slice(0, 150)
      }
    } catch {
      // skip malformed
    }
  }

  return null
}

// ── Active process tracking ─────────────────────────────────────────────

export const activeProcesses = new Map<string, ReturnType<typeof spawn>>()

// ── Persistent sessions ─────────────────────────────────────────────────

export interface PersistentSession {
  proc: ChildProcess
  /** Resolves when the current turn's `result` message arrives */
  onResult: ((msg: { type: string; subtype?: string; is_error?: boolean; result?: string }) => void) | null
  /** Set to true once the process has exited */
  dead: boolean
  cwd: string
  permArgs: string[]
  modelArgs: string[]
  /** Path to the session's JSONL file */
  jsonlPath: string | null
  /** Active Task tool_use IDs -> prompt text (for matching subagent files) */
  pendingTaskCalls: Map<string, string>
  /** Subagent directory watcher (cleaned up on process close) */
  subagentWatcher: SubagentWatcher | null
  /** Worktree name if session was created with --worktree */
  worktreeName: string | null
}
export const persistentSessions = new Map<string, PersistentSession>()

export interface FileChange {
  path: string
  status: "M" | "A" | "D" | "R"
  additions: number
  deletions: number
}

export interface WorktreeInfo {
  name: string
  path: string
  branch: string
  head: string
  headMessage: string
  isDirty: boolean
  commitsAhead: number
  linkedSessions: string[]
  createdAt: string
  changedFiles: FileChange[]
}

/** Convert a user message into a valid worktree/branch name. */
export function slugifyWorktreeName(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "")
}

/** Find the JSONL file path for a session by searching all project directories. */
export async function findJsonlPath(sessionId: string): Promise<string | null> {
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

// ── Subagent JSONL watcher ───────────────────────────────────────────────
// Claude Code doesn't reliably write agent_progress to the parent JSONL
// when using --output-format stream-json.  The subagent data IS written to
// separate files under <sessionId>/subagents/agent-<id>.jsonl.  This watcher
// monitors those files and synthesizes agent_progress entries into the parent
// JSONL so the SSE file watcher can stream them to the UI.

interface SubagentWatcher {
  close(): void
}

/**
 * Watch for subagent JSONL files and forward their content as agent_progress
 * entries into the parent session JSONL.
 *
 * @param parentJsonlPath  Path to the parent session's JSONL file
 * @param sessionId        The parent session UUID
 * @param pendingTaskCalls Map of tool_use_id -> prompt for active Task tool calls.
 *                         Updated externally by the stdout parser when it sees Task tool_use/result.
 */
export function watchSubagents(
  parentJsonlPath: string,
  sessionId: string,
  pendingTaskCalls: Map<string, string>,
): SubagentWatcher {
  const subagentsDir = parentJsonlPath.replace(/\.jsonl$/, "") + "/subagents"

  // Track offsets per subagent file and their parentToolUseID mapping
  const fileOffsets = new Map<string, number>()
  const agentToParentToolId = new Map<string, string>()
  let closed = false
  let dirWatcher: ReturnType<typeof watch> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function processAgentFile(filePath: string, agentFileName: string) {
    if (closed) return
    const agentId = agentFileName.replace("agent-", "").replace(".jsonl", "")
    const offset = fileOffsets.get(filePath) ?? 0

    try {
      const s = await stat(filePath)
      if (s.size <= offset) return

      const fh = await open(filePath, "r")
      try {
        const buf = Buffer.alloc(s.size - offset)
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
        fileOffsets.set(filePath, s.size)

        const text = buf.subarray(0, bytesRead).toString("utf-8")
        const lines = text.split("\n").filter(Boolean)

        for (const line of lines) {
          try {
            const msg = JSON.parse(line)
            if (msg.type !== "user" && msg.type !== "assistant") continue

            // Resolve parentToolUseID for this agent
            let parentToolId = agentToParentToolId.get(agentId)
            if (!parentToolId) {
              // Match by prompt: the subagent's first user message text
              // should match a pending Task tool call's prompt
              const msgContent = msg.message?.content
              let promptText = ""
              if (typeof msgContent === "string") {
                promptText = msgContent
              } else if (Array.isArray(msgContent)) {
                for (const b of msgContent) {
                  if (b.type === "text") { promptText = b.text; break }
                }
              }
              if (promptText) {
                for (const [toolId, taskPrompt] of pendingTaskCalls) {
                  if (taskPrompt === promptText || promptText.startsWith(taskPrompt.slice(0, 100))) {
                    parentToolId = toolId
                    agentToParentToolId.set(agentId, toolId)
                    break
                  }
                }
              }
            }
            if (!parentToolId) continue

            // Synthesize an agent_progress entry matching Claude Code's format
            const progressEntry = {
              type: "progress",
              parentUuid: "",
              isSidechain: false,
              cwd: msg.cwd || "",
              sessionId,
              uuid: randomUUID(),
              timestamp: msg.timestamp || new Date().toISOString(),
              parentToolUseID: parentToolId,
              toolUseID: `agent_msg_synth_${randomUUID().slice(0, 12)}`,
              data: {
                type: "agent_progress",
                agentId,
                prompt: "",
                normalizedMessages: [],
                message: {
                  type: msg.type,
                  message: msg.message,
                  uuid: msg.uuid || randomUUID(),
                  timestamp: msg.timestamp || new Date().toISOString(),
                },
              },
            }

            await appendFile(parentJsonlPath, JSON.stringify(progressEntry) + "\n").catch(() => {})
          } catch {
            // skip malformed lines
          }
        }
      } finally {
        await fh.close()
      }
    } catch {
      // file may not exist yet
    }
  }

  async function scanDir() {
    if (closed) return
    try {
      const files = await readdir(subagentsDir)
      for (const f of files) {
        if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
          await processAgentFile(join(subagentsDir, f), f)
        }
      }
    } catch {
      // directory may not exist yet
    }
  }

  // Watch the subagents directory for changes
  try {
    dirWatcher = watch(subagentsDir, { recursive: true }, () => {
      if (!closed) scanDir()
    })
    dirWatcher.on("error", () => {}) // dir may not exist yet
  } catch {
    // directory doesn't exist yet — poller will pick up changes
  }

  // Poll as fallback (subagents dir may be created after we start watching)
  pollTimer = setInterval(scanDir, 500)

  // Initial scan
  scanDir()

  return {
    close() {
      closed = true
      dirWatcher?.close()
      dirWatcher = null
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
    },
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────

export function cleanupProcesses(): void {
  for (const [sid, proc] of activeProcesses) {
    try { proc.kill("SIGTERM") } catch { /* already dead */ }
    activeProcesses.delete(sid)
  }
  for (const [sid, ps] of persistentSessions) {
    ps.subagentWatcher?.close()
    try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
    persistentSessions.delete(sid)
  }
}

// Re-export utilities needed by route handlers that spawn processes
export { spawn, createInterface, appendFile, homedir }
export { readdir, readFile, stat, open } from "node:fs/promises"
export { writeFile, mkdir, unlink, lstat } from "node:fs/promises"
export { join, resolve } from "node:path"
export { watch }
export { createConnection } from "node:net"
export { randomUUID }
