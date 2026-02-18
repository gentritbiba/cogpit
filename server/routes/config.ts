import type { UseFn } from "../helpers"
import {
  refreshDirs,
  isLocalRequest,
  isRateLimited,
  createSessionToken,
  verifyPassword,
  hashPassword,
  validatePasswordStrength,
  revokeAllSessions,
} from "../helpers"
import { getConfig, saveConfig, validateClaudeDir } from "../config"
import { networkInterfaces } from "node:os"

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
  use("/api/auth/verify", (req, res, next) => {
    if (req.method !== "POST") return next()
    res.setHeader("Content-Type", "application/json")

    // Local requests always pass
    if (isLocalRequest(req)) {
      res.end(JSON.stringify({ valid: true }))
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

    if (!verifyPassword(password, config.networkPassword)) {
      res.statusCode = 401
      res.end(JSON.stringify({ valid: false, error: "Invalid password" }))
      return
    }

    // Issue a session token instead of letting client reuse the password
    const sessionToken = createSessionToken(req.socket.remoteAddress || "unknown")
    res.end(JSON.stringify({ valid: true, token: sessionToken }))
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
        networkAccess: config.networkAccess || false,
        networkPassword: config.networkPassword ? "set" : null,
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

          const validation = await validateClaudeDir(claudeDir)
          if (!validation.valid) {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: validation.error }))
            return
          }

          const currentConfig = getConfig()

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
            claudeDir: validation.resolved || claudeDir,
            networkAccess: !!parsed.networkAccess,
            networkPassword: finalPassword,
          })
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
}
