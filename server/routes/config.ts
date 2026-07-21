import type { UseFn } from "../http"
import {
  refreshDirs,
  isTrustedDirectLocalRequest,
  hasTrustedMutationSource,
  canIssueBrowserSession,
  isRateLimited,
  createSessionToken,
  getRequestSessionToken,
  setBrowserSessionCookie,
  clearBrowserSessionCookie,
  revokeSessionToken,
  verifyPasswordAsync,
  needsPasswordRehash,
  hashPassword,
  validatePasswordStrength,
  revokeAllSessions,
  getConnectedDevices,
} from "../helpers"
import { getConfig, saveConfig, validateClaudeDir } from "../config"
import { networkInterfaces } from "node:os"
import { resolve } from "node:path"

const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 2
let activePasswordVerifications = 0

async function verifyRemotePassword(
  password: string,
  stored: string,
): Promise<"valid" | "invalid" | "busy"> {
  if (activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS) return "busy"
  activePasswordVerifications += 1
  try {
    return await verifyPasswordAsync(password, stored) ? "valid" : "invalid"
  } finally {
    activePasswordVerifications -= 1
  }
}

function getLanIp(): string | null {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}

export function registerConfigRoutes(use: UseFn) {
  // GET /api/network-info
  use("/api/network-info", (req, res, next) => {
    if (req.method !== "GET") return next()
    const config = getConfig()
    if (!config?.networkAccess || !config?.networkPassword) {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ enabled: false }))
      return
    }
    const host = getLanIp()
    const port = (req.socket.address() as { port?: number })?.port || 19384
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({
      enabled: true,
      host,
      port,
      url: host ? `http://${host}:${port}` : null,
    }))
  })

  // POST /api/auth/verify — public endpoint, validates password and issues session token
  use("/api/auth/verify", async (req, res, next) => {
    if (req.method !== "POST") return next()
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Cache-Control", "no-store")

    // Direct local clients do not need a network password. Requests forwarded
    // by a loopback reverse proxy remain remote and must authenticate below.
    if (isTrustedDirectLocalRequest(req)) {
      res.end(JSON.stringify({ valid: true }))
      return
    }

    if (!hasTrustedMutationSource(req)) {
      res.statusCode = 403
      res.end(JSON.stringify({ valid: false, error: "Untrusted request source" }))
      return
    }

    const browserLogin = req.headers["x-cogpit-client"] === "1"
    if (browserLogin && !canIssueBrowserSession(req)) {
      res.statusCode = 426
      res.end(JSON.stringify({
        valid: false,
        error: "Secure HTTPS is required for remote browser access",
      }))
      return
    }

    // Rate limit remote auth attempts
    if (isRateLimited(req)) {
      res.statusCode = 429
      res.end(JSON.stringify({ valid: false, error: "Too many attempts. Try again in 1 minute." }))
      return
    }

    const config = getConfig()
    if (!config?.networkAccess || !config?.networkPassword) {
      res.statusCode = 403
      res.end(JSON.stringify({ valid: false, error: "Network access is disabled" }))
      return
    }

    const authHeader = req.headers.authorization
    const password = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null

    if (!password) {
      res.statusCode = 401
      res.end(JSON.stringify({ valid: false, error: "Password required" }))
      return
    }

    const verification = await verifyRemotePassword(password, config.networkPassword)
    if (verification === "busy") {
      res.statusCode = 429
      res.end(JSON.stringify({ valid: false, error: "Authentication is busy. Try again shortly." }))
      return
    }
    if (verification === "invalid") {
      res.statusCode = 401
      res.end(JSON.stringify({ valid: false, error: "Invalid password" }))
      return
    }

    const strengthError = validatePasswordStrength(password)
    if (strengthError) {
      res.statusCode = 403
      res.end(JSON.stringify({
        valid: false,
        error: `${strengthError}. Update it from the local Cogpit app.`,
      }))
      return
    }

    // Upgrade historical SHA-256/plaintext credentials after a successful
    // login. Failure to persist the upgrade must not invalidate a correct
    // password; the existing credential remains usable and can retry later.
    if (needsPasswordRehash(config.networkPassword)) {
      try {
        await saveConfig({
          ...config,
          networkPassword: hashPassword(password),
        })
      } catch {
        // Best-effort migration; authentication itself already succeeded.
      }
    }

    // Issue a session token instead of letting client reuse the password
    const sessionToken = createSessionToken(req.socket.remoteAddress || "unknown", req.headers["user-agent"])
    if (browserLogin) {
      setBrowserSessionCookie(res, sessionToken)
      res.end(JSON.stringify({ valid: true }))
    } else {
      // Machine clients cannot use HttpOnly cookies and retain the documented
      // bearer-token contract. Browser callers never receive the token body.
      res.end(JSON.stringify({ valid: true, token: sessionToken }))
    }
  })

  // GET /api/auth/session — protected by authMiddleware; lets the browser
  // restore its UI state without exposing the HttpOnly token to JavaScript.
  use("/api/auth/session", (req, res, next) => {
    if (req.method !== "GET") return next()
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Cache-Control", "no-store")
    res.end(JSON.stringify({ authenticated: true }))
  })

  // POST /api/auth/logout — revoke only the current session and expire the
  // browser cookie. Password changes still revoke every session below.
  use("/api/auth/logout", (req, res, next) => {
    if (req.method !== "POST") return next()
    const token = getRequestSessionToken(req)
    if (token) revokeSessionToken(token)
    clearBrowserSessionCookie(res)
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Cache-Control", "no-store")
    res.end(JSON.stringify({ valid: true }))
  })

  // GET /api/connected-devices — list active remote sessions
  use("/api/connected-devices", (req, res, next) => {
    if (req.method !== "GET") return next()
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ devices: getConnectedDevices() }))
  })

  // GET /api/config/validate?path=... - validate a path without saving
  use("/api/config/validate", async (req, res, next) => {
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
  use("/api/config", async (req, res, next) => {
    if (req.method === "GET") {
      // Only handle exact path
      if (req.url && req.url !== "/" && req.url !== "" && !req.url.startsWith("?")) return next()
      const config = getConfig()
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(config ? {
        claudeDir: config.claudeDir,
        mode: config.codexOnly ? "codex" : "claude",
        networkAccess: config.networkAccess || false,
        networkPassword: config.networkPassword ? "set" : null,
        terminalApp: config.terminalApp || null,
        editorApp: config.editorApp || null,
      } : null))
      return
    }

    if (req.method === "POST") {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body)
          const { claudeDir } = parsed
          if (!claudeDir || typeof claudeDir !== "string") {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: "claudeDir string required" }))
            return
          }

          const currentConfig = getConfig()
          const validation = await validateClaudeDir(claudeDir)
          // A Codex-only bootstrap deliberately does not require
          // ~/.claude/projects. Allow saving unrelated settings while that
          // compatibility path is unchanged; any new Claude path must still
          // pass the normal validation above.
          const reusingCodexFallback = !!currentConfig?.codexOnly
            && resolve(claudeDir) === resolve(currentConfig.claudeDir)
          if (!validation.valid && !reusingCodexFallback) {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: validation.error }))
            return
          }
          const resolvedClaudeDir = validation.resolved
            || (reusingCodexFallback ? currentConfig.claudeDir : claudeDir)

          // Handle password: new password provided, or keep existing
          let finalPassword = currentConfig?.networkPassword || undefined
          if (parsed.networkPassword && typeof parsed.networkPassword === "string") {
            // Validate password strength
            const strengthError = validatePasswordStrength(parsed.networkPassword)
            if (strengthError) {
              res.statusCode = 400
              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ error: strengthError }))
              return
            }
            // Hash the new password before storing
            finalPassword = hashPassword(parsed.networkPassword)
            // Revoke all existing sessions when password changes
            revokeAllSessions()
          }

          if (parsed.networkAccess && !finalPassword) {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: "Password required when enabling network access" }))
            return
          }

          // If disabling network access, revoke all sessions
          if (!parsed.networkAccess && currentConfig?.networkAccess) {
            revokeAllSessions()
          }

          await saveConfig({
            claudeDir: resolvedClaudeDir,
            codexOnly: reusingCodexFallback || undefined,
            networkAccess: !!parsed.networkAccess,
            networkPassword: finalPassword,
            terminalApp: parsed.terminalApp || undefined,
            editorApp: parsed.editorApp || undefined,
          })
          refreshDirs()

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            success: true,
            claudeDir: resolvedClaudeDir,
          }))
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
}
