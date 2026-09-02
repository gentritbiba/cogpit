/**
 * The server's import seam — and nothing else.
 *
 * Every export below is a re-export. No logic lives here: a route needing a
 * behaviour imports the module that owns it (`./lib/rateLimit`,
 * `./lib/projectNames`, `./agents/spawnError`, …), and this file exists only so
 * that the node builtins a route reaches for arrive through one named module.
 *
 * That indirection is load-bearing for the tests: `vi.mock("../helpers")`
 * replaces `spawn`/`readFile` for the handlers under test alone, where mocking
 * `node:child_process` would replace them for the whole module graph. Add a
 * re-export here only for a node builtin; anything with behaviour belongs in a
 * module of its own.
 */
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

export type { AgentKind } from "../shared/session/types"
export type { NextFn, Middleware, UseFn } from "./http"
export type { FileChange, WorktreeInfo } from "../shared/contracts/worktrees"

export {
  activeProcesses,
  persistentSessions,
  cleanupProcesses,
} from "./processRegistry"
export type { PermissionRequest, PersistentSession } from "./processRegistry"

export { isWithinDir } from "./pathSafety"

export { dirs, refreshDirs } from "./dirs"

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
  revokeSessionsForUser,
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
  devSecurityHeaders,
  bodySizeLimit,
  authMiddleware,
} from "./security"

export { getSessionMeta, getSessionStatus, searchSessionMessages, readTranscriptEffort } from "./sessionMetadata"

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
