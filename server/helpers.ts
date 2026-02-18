import type { ChildProcess } from "node:child_process"
import { readdir, readFile, stat, open } from "node:fs/promises"
import { join } from "node:path"
import { resolve } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { appendFile } from "node:fs/promises"
import { timingSafeEqual, randomBytes, createHash } from "node:crypto"

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

// Periodically clean up expired entries
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, 60_000)

// ── Session token system ────────────────────────────────────────────────

const activeSessions = new Map<string, { createdAt: number; ip: string }>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export function createSessionToken(ip: string): string {
  const token = randomBytes(32).toString("hex")
  activeSessions.set(token, { createdAt: Date.now(), ip })
  return token
}

export function validateSessionToken(token: string): boolean {
  const session = activeSessions.get(token)
  if (!session) return false
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    activeSessions.delete(token)
    return false
  }
  return true
}

export function revokeAllSessions(): void {
  activeSessions.clear()
}

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now()
  for (const [token, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) activeSessions.delete(token)
  }
}, 60_000)

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
  /** Path to the session's JSONL file (for forwarding progress events) */
  jsonlPath: string | null
}
export const persistentSessions = new Map<string, PersistentSession>()

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

// ── Cleanup ─────────────────────────────────────────────────────────────

export function cleanupProcesses(): void {
  for (const [sid, proc] of activeProcesses) {
    try { proc.kill("SIGTERM") } catch { /* already dead */ }
    activeProcesses.delete(sid)
  }
  for (const [sid, ps] of persistentSessions) {
    try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
    persistentSessions.delete(sid)
  }
}

// Re-export utilities needed by route handlers that spawn processes
export { spawn, createInterface, appendFile, homedir }
export { readdir, readFile, stat, open } from "node:fs/promises"
export { writeFile, mkdir, unlink, lstat } from "node:fs/promises"
export { join, resolve } from "node:path"
export { watch } from "node:fs"
export { createConnection } from "node:net"
export { randomUUID } from "node:crypto"
