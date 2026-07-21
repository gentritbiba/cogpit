import { readdir, open, writeFile, unlink } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { randomUUID, createHash } from "node:crypto"
import { dirs } from "./sessionPaths"
import {
  buildClaudePermArgs,
  buildCodexPermArgs as _buildCodexPermArgs,
  buildCodexEffortArgs as _buildCodexEffortArgs,
  buildCodexModelArgs as _buildCodexModelArgs,
  buildCodexFastModeArgs as _buildCodexFastModeArgs,
} from "../shared/providers"
import type { PermissionsConfig } from "../shared/providers/types"
export type { AgentKind } from "../shared/providers/types"

// ── Shared types ────────────────────────────────────────────────────────

import type { IncomingMessage } from "node:http"

export type { NextFn, Middleware, UseFn } from "./http"

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
export function buildPermArgs(permissions?: PermissionsConfig): string[] {
  return buildClaudePermArgs(permissions)
}

/** Build Codex CLI permission args (delegates to providers/codex) */
export function buildCodexPermArgs(permissions?: PermissionsConfig): string[] {
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

/** Build Codex Fast-mode config args (delegates to providers/codex) */
export function buildCodexFastModeArgs(enabled?: boolean): string[] {
  return _buildCodexFastModeArgs(enabled)
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

// ── Rate limiting ────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = 60_000  // 1 minute
const RATE_LIMIT_MAX_ATTEMPTS = 5    // 5 attempts per window
const RATE_LIMIT_CONNECTOR_MAX_ATTEMPTS = 30

function getRateLimitKey(req: IncomingMessage): string {
  const forwarded = req.headers?.["cf-connecting-ip"] ?? req.headers?.["x-forwarded-for"]
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const client = value?.split(",")[0]?.trim()
  return client ? `client:${client.slice(0, 128)}` : `socket:${req.socket.remoteAddress || "unknown"}`
}

function consumeRateLimit(key: string, maxAttempts: number, now: number): boolean {
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count += 1
  return entry.count > maxAttempts
}

export function isRateLimited(req: IncomingMessage): boolean {
  const now = Date.now()
  const clientKey = getRateLimitKey(req)
  const socketKey = `socket:${req.socket.remoteAddress || "unknown"}`

  const clientLimited = consumeRateLimit(clientKey, RATE_LIMIT_MAX_ATTEMPTS, now)
  if (clientKey === socketKey) return clientLimited

  // Reverse proxies multiplex many real clients over one connector. Keep a
  // higher connector-wide ceiling so spoofed forwarding headers cannot turn
  // into unlimited password work, without letting one IP lock everybody out.
  const connectorLimited = consumeRateLimit(socketKey, RATE_LIMIT_CONNECTOR_MAX_ATTEMPTS, now)
  return clientLimited || connectorLimited
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

/**
 * Read a session's agent-team identity from the head of its JSONL file.
 * Claude Code 2.1.19x+ runs team members as their own top-level sessions
 * whose message lines carry `teamName` and `agentName` fields.
 */
export async function readSessionTeamTags(
  filePath: string
): Promise<{ teamName: string | null; agentName: string | null }> {
  try {
    const fh = await open(filePath, "r")
    try {
      const buf = Buffer.alloc(32768)
      const { bytesRead } = await fh.read(buf, 0, 32768, 0)
      const text = buf.subarray(0, bytesRead).toString("utf-8")
      const lines = text.split("\n")
      // The last line may be cut off mid-JSON when the file is larger than the read
      const complete = bytesRead === 32768 ? lines.slice(0, -1) : lines
      for (const line of complete.slice(0, 40)) {
        if (!line || !line.includes('"teamName"')) continue
        try {
          const obj = JSON.parse(line)
          if (typeof obj.teamName === "string" && obj.teamName) {
            return {
              teamName: obj.teamName,
              agentName: typeof obj.agentName === "string" && obj.agentName ? obj.agentName : null,
            }
          }
        } catch { /* skip malformed */ }
      }
      return { teamName: null, agentName: null }
    } finally {
      await fh.close()
    }
  } catch {
    return { teamName: null, agentName: null }
  }
}

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

// Compatibility export for existing server consumers. New cross-runtime
// consumers should import the neutral wire contract directly.
export type { FileChange, WorktreeInfo } from "../shared/contracts/worktrees"

// ── Re-exports from extracted modules ───────────────────────────────────

export {
  activeProcesses,
  persistentSessions,
  cleanupProcesses,
} from "./processRegistry"
export type { PermissionRequest, PersistentSession } from "./processRegistry"

export { isWithinDir } from "./pathSafety"

export {
  dirs,
  CODEX_HOME_DIR,
  CODEX_SESSIONS_DIR,
  isCodexDirName,
  encodeCodexDirName,
  decodeCodexDirName,
  isCodexFilePath,
  formatCodexRolloutFileName,
  refreshDirs,
  listCodexSessionFiles,
  resolveSessionFilePath,
  getAgentKindFromSessionPath,
  findNewestCodexSessionForCwd,
  findJsonlPath,
} from "./sessionPaths"
export type { SessionFileInfo } from "./sessionPaths"

export {
  isLocalRequest,
  isTrustedLocalHost,
  isForwardedRequest,
  isTrustedDirectLocalRequest,
  websocketUpgradeRejection,
  safeCompare,
  createSessionToken,
  getRequestSessionToken,
  setBrowserSessionCookie,
  clearBrowserSessionCookie,
  canIssueBrowserSession,
  hasTrustedMutationSource,
  validateSessionToken,
  revokeSessionToken,
  revokeAllSessions,
  getConnectedDevices,
  hashPassword,
  isPasswordHashed,
  isMalformedPasswordHash,
  needsPasswordRehash,
  verifyPassword,
  verifyPasswordAsync,
  MIN_PASSWORD_LENGTH,
  validatePasswordStrength,
  securityHeaders,
  bodySizeLimit,
  authMiddleware,
} from "./security"

export { getSessionMeta, getSessionStatus, searchSessionMessages } from "./sessionMetadata"

// ── Shared route helpers ────────────────────────────────────────────────────

export { sendJson } from "./http"

export { watchSubagents } from "./subagentWatcher"

// Re-export utilities needed by route handlers that spawn processes
export { spawn, homedir, randomUUID }
export { createInterface } from "node:readline"
export { readdir, readFile, stat, open } from "node:fs/promises"
export { writeFile, mkdir, unlink, lstat } from "node:fs/promises"
export { join, resolve, basename, dirname } from "node:path"
export { watch } from "node:fs"
export { createConnection } from "node:net"
