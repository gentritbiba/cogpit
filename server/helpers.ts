import type { ChildProcess } from "node:child_process"
import { readdir, open, stat, writeFile, unlink, mkdir, readFile } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { randomUUID, createHash } from "node:crypto"
import { getConfig, getDirs } from "./config"
import {
  buildClaudePermArgs,
  buildCodexPermArgs as _buildCodexPermArgs,
  buildCodexEffortArgs as _buildCodexEffortArgs,
  buildCodexModelArgs as _buildCodexModelArgs,
  isCodexDirName as _isCodexDirName,
  encodeCodexDirName as _encodeCodexDirName,
  decodeCodexDirName as _decodeCodexDirName,
  CODEX_PREFIX,
} from "../src/lib/providers/index"
export type { AgentKind } from "../src/lib/providers/types"

// ── Shared types ────────────────────────────────────────────────────────

import type { IncomingMessage, ServerResponse } from "node:http"

export type NextFn = (err?: unknown) => void
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: NextFn) => void
export type UseFn = (path: string, handler: Middleware) => void

// ── Friendly error formatter ────────────────────────────────────────────

export function friendlySpawnError(err: NodeJS.ErrnoException, cli: "claude" | "codex" = "claude"): string {
  if (err.code === "ENOENT") {
    return cli === "codex"
      ? "Codex CLI is not installed or not found in PATH."
      : "Claude CLI is not installed or not found in PATH. Install it with: npm install -g @anthropic-ai/claude-code"
  }
  return err.message
}

// ── MCP config args builder ──────────────────────────────────────────────

/**
 * Build CLI args to control which MCP servers are loaded.
 * Writes the config to a temp file and passes the file path,
 * because --mcp-config is variadic and inline JSON causes parsing issues.
 *
 * @param mcpConfig - JSON string of `{"mcpServers":{...}}` with only selected servers, or null/undefined to use defaults
 */
export function buildMcpArgs(mcpConfig: unknown): string[] {
  if (typeof mcpConfig !== "string" || !mcpConfig) return []

  try {
    JSON.parse(mcpConfig)
  } catch {
    return []
  }

  const hash = createHash("md5").update(mcpConfig).digest("hex").slice(0, 8)
  const tmpPath = join(tmpdir(), `cogpit-mcp-${hash}.json`)
  writeFileSync(tmpPath, mcpConfig, "utf-8")
  return ["--strict-mcp-config", "--mcp-config", tmpPath]
}

// ── Permission args builder ─────────────────────────────────────────────

/** Build Claude CLI permission args (delegates to providers/claude) */
export function buildPermArgs(permissions?: { mode?: string; allowedTools?: string[]; disallowedTools?: string[] }): string[] {
  return buildClaudePermArgs(permissions)
}

/** Build Codex CLI permission args (delegates to providers/codex) */
export function buildCodexPermArgs(permissions?: { mode?: string; allowedTools?: string[]; disallowedTools?: string[] }): string[] {
  return _buildCodexPermArgs(permissions)
}

/** Build Codex effort args (delegates to providers/codex) */
export function buildCodexEffortArgs(effort?: string): string[] {
  return _buildCodexEffortArgs(effort)
}

/** Build Codex model args (delegates to providers/codex) */
export function buildCodexModelArgs(model?: string): string[] {
  return _buildCodexModelArgs(model)
}

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

export async function writeTempImageFiles(
  images?: Array<{ data: string; mediaType: string }>
): Promise<string[]> {
  if (!Array.isArray(images) || images.length === 0) return []

  const files: string[] = []
  for (const [index, image] of images.entries()) {
    const ext = IMAGE_EXT[image.mediaType] ?? "png"
    const filePath = join(tmpdir(), `cogpit-codex-image-${Date.now()}-${index}.${ext}`)
    await writeFile(filePath, Buffer.from(image.data, "base64"))
    files.push(filePath)
  }
  return files
}

export async function cleanupTempFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map(async (filePath) => {
    try {
      await unlink(filePath)
    } catch {
      // ignore cleanup failures
    }
  }))
}

// ── Mutable directory references ────────────────────────────────────

export const dirs = {
  PROJECTS_DIR: "",
  TEAMS_DIR: "",
  TASKS_DIR: "",
  UNDO_DIR: "",
}

/** @deprecated Use CODEX_PREFIX from src/lib/providers/codex */
export const CODEX_PROJECT_PREFIX = CODEX_PREFIX
export const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions")

/** Delegates to providers/codex.isCodexDirName */
export function isCodexDirName(dirName: string): boolean {
  return _isCodexDirName(dirName)
}

/**
 * Encode a cwd path as a Codex dirName.
 * Server-side uses Buffer for Node.js native base64url encoding.
 */
export function encodeCodexDirName(cwd: string): string {
  return `${CODEX_PREFIX}${Buffer.from(cwd).toString("base64url")}`
}

/** Delegates to providers/codex.decodeCodexDirName */
export function decodeCodexDirName(dirName: string): string | null {
  return _decodeCodexDirName(dirName)
}

export function isCodexFilePath(filePath: string): boolean {
  return filePath.startsWith(CODEX_SESSIONS_DIR + "/")
}

export function formatCodexRolloutFileName(sessionId: string, now = new Date()): string {
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  const hour = String(now.getHours()).padStart(2, "0")
  const minute = String(now.getMinutes()).padStart(2, "0")
  const second = String(now.getSeconds()).padStart(2, "0")
  return `${year}/${month}/${day}/rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-${sessionId}.jsonl`
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
  return entry.count > RATE_LIMIT_MAX_ATTEMPTS
}

// Periodically clean up expired entries (unref so build process can exit)
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, 60_000).unref()

// ── Subagent matching ───────────────────────────────────────────────

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

export interface SessionFileInfo {
  filePath: string
  fileName: string
  mtimeMs: number
  size: number
}

export async function listCodexSessionFiles(): Promise<SessionFileInfo[]> {
  const walk = async (dir: string, depth: number): Promise<SessionFileInfo[]> => {
    let entries: import("node:fs").Dirent[] | string[] | undefined
    try {
      entries = await readdir(dir, { withFileTypes: true }) as import("node:fs").Dirent[]
    } catch {
      return []
    }
    if (!Array.isArray(entries)) return []

    const results: SessionFileInfo[] = []
    for (const entry of entries) {
      if (!("name" in entry)) continue
      const filePath = join(dir, entry.name)
      if ("isDirectory" in entry && typeof entry.isDirectory === "function" && entry.isDirectory()) {
        if (depth < 4) results.push(...await walk(filePath, depth + 1))
        continue
      }
      if (!entry.name.endsWith(".jsonl")) continue
      try {
        const s = await stat(filePath)
        results.push({
          filePath,
          fileName: filePath.slice(CODEX_SESSIONS_DIR.length + 1),
          mtimeMs: s.mtimeMs,
          size: s.size,
        })
      } catch {
        continue
      }
    }
    return results
  }

  return walk(CODEX_SESSIONS_DIR, 0)
}

export async function resolveSessionFilePath(dirName: string, fileName: string): Promise<string | null> {
  if (isCodexDirName(dirName)) {
    const filePath = join(CODEX_SESSIONS_DIR, fileName)
    return isWithinDir(CODEX_SESSIONS_DIR, filePath) ? filePath : null
  }

  const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
  return isWithinDir(dirs.PROJECTS_DIR, filePath) ? filePath : null
}

export function getAgentKindFromSessionPath(filePath: string | null | undefined): AgentKind {
  return typeof filePath === "string" && isCodexFilePath(filePath) ? "codex" : "claude"
}

export async function findNewestCodexSessionForCwd(
  cwd: string,
  knownPaths: Set<string>,
  startedAt: number,
): Promise<{ filePath: string; fileName: string; sessionId: string } | null> {
  const files = await listCodexSessionFiles()
  const candidates = files
    .filter((file) => !knownPaths.has(file.filePath) && file.mtimeMs >= startedAt - 1_000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const file of candidates) {
    try {
      const meta = await getSessionMeta(file.filePath)
      if (meta.cwd !== cwd || !meta.sessionId) continue
      return {
        filePath: file.filePath,
        fileName: file.fileName,
        sessionId: meta.sessionId,
      }
    } catch {
      continue
    }
  }

  return null
}


// ── Active process tracking ─────────────────────────────────────────────

export const activeProcesses = new Map<string, ReturnType<typeof spawn>>()

// ── Persistent sessions ─────────────────────────────────────────────────

import type { SubagentWatcher } from "./subagentWatcher"

export interface PersistentSession {
  agentKind: AgentKind
  proc: ChildProcess
  /** Resolves when the current turn's `result` message arrives */
  onResult: ((msg: { type: string; subtype?: string; is_error?: boolean; result?: string }) => void) | null
  /** Set to true once the process has exited */
  dead: boolean
  cwd: string
  permArgs: string[]
  modelArgs: string[]
  effortArgs: string[]
  /** Path to the session's JSONL file */
  jsonlPath: string | null
  /** Active Task tool_use IDs -> prompt text (for matching subagent files) */
  pendingTaskCalls: Map<string, string>
  /** Subagent directory watcher (cleaned up on process close) */
  subagentWatcher: SubagentWatcher | null
  /** Worktree name if session was created with --worktree */
  worktreeName: string | null
  /** Temporary files created for a request, such as Codex image attachments */
  tempFiles?: string[]
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

  try {
    const codexFiles = await listCodexSessionFiles()
    const match = codexFiles.find((file) => file.fileName.endsWith(`${sessionId}.jsonl`))
    if (match) return match.filePath
  } catch {
    // ignore codex lookup errors
  }
  return null
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

// ── Re-exports from extracted modules ───────────────────────────────────

export {
  isLocalRequest,
  safeCompare,
  createSessionToken,
  validateSessionToken,
  revokeAllSessions,
  getConnectedDevices,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  validatePasswordStrength,
  securityHeaders,
  bodySizeLimit,
  authMiddleware,
} from "./security"

export { getSessionMeta, getSessionStatus, searchSessionMessages } from "./sessionMetadata"

// ── Shared route helpers ────────────────────────────────────────────────────

export function sendJson(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

export { watchSubagents } from "./subagentWatcher"

// Re-export utilities needed by route handlers that spawn processes
export { spawn, homedir, randomUUID }
export { createInterface } from "node:readline"
export { readdir, readFile, stat, open } from "node:fs/promises"
export { writeFile, mkdir, unlink, lstat } from "node:fs/promises"
export { join, resolve, basename, dirname } from "node:path"
export { watch } from "node:fs"
export { createConnection } from "node:net"
