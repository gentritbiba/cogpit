import type { ChildProcess } from "node:child_process"
import { readdir, open } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
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

// ── Permission args builder ─────────────────────────────────────────────

/**
 * Build CLI permission args from a parsed permissions config object.
 * Auto-approves ExitPlanMode and AskUserQuestion for non-bypass modes
 * since these interactive tools can't receive stdin approval through
 * stream-json user messages (causes an infinite retry loop in -p mode).
 */
export function buildPermArgs(permissions?: { mode?: string; allowedTools?: string[]; disallowedTools?: string[] }): string[] {
  if (permissions && typeof permissions.mode === "string" && permissions.mode !== "bypassPermissions") {
    const args = ["--permission-mode", permissions.mode]
    if (Array.isArray(permissions.allowedTools)) {
      for (const tool of permissions.allowedTools) {
        args.push("--allowedTools", tool)
      }
    }
    if (Array.isArray(permissions.disallowedTools)) {
      for (const tool of permissions.disallowedTools) {
        args.push("--disallowedTools", tool)
      }
    }
    args.push("--allowedTools", "ExitPlanMode")
    args.push("--allowedTools", "AskUserQuestion")
    return args
  }
  return ["--dangerously-skip-permissions"]
}

// ── Mutable directory references ────────────────────────────────────

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

// ── Active process tracking ─────────────────────────────────────────────

export const activeProcesses = new Map<string, ReturnType<typeof spawn>>()

// ── Persistent sessions ─────────────────────────────────────────────────

import type { SubagentWatcher } from "./subagentWatcher"

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

export { getSessionMeta, searchSessionMessages } from "./sessionMetadata"
export { watchSubagents } from "./subagentWatcher"
export type { SubagentWatcher } from "./subagentWatcher"

// Re-export utilities needed by route handlers that spawn processes
export { spawn, homedir, randomUUID }
export { createInterface } from "node:readline"
export { appendFile } from "node:fs/promises"
export { readdir, readFile, stat, open } from "node:fs/promises"
export { writeFile, mkdir, unlink, lstat } from "node:fs/promises"
export { join, resolve } from "node:path"
export { watch } from "node:fs"
export { createConnection } from "node:net"
