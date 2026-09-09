import type { IncomingMessage, ServerResponse } from "node:http"
import { HttpBodyError, readJsonBody, sendJson, withJsonBody, type UseFn } from "../http"
import {
  refreshDirs,
  isTrustedDirectLocalRequest,
  hasTrustedMutationSource,
  canIssueBrowserSession,
  createSessionToken,
  getRequestSessionToken,
  setBrowserSessionCookie,
  clearBrowserSessionCookie,
  revokeSessionToken,
  needsPasswordRehash,
  hashPassword,
  validatePasswordStrength,
  revokeAllSessions,
  getConnectedDevices,
} from "../helpers"
import { isRateLimited } from "../lib/rateLimit"
import { verifyRemotePassword, getDummyHash } from "../password-verify"
import { revokeAllShareTokens, type SessionPrincipal } from "../security"
import { clearAllShares } from "../share/registry"
import { isTeamEdition } from "../team/edition"
import { getUserByUsername, withVerifiedUser } from "../team/users"
import { getConfig, getConfiguredEditionValue, saveConfig, validateClaudeDir } from "../config"
import { descriptorForDirName } from "../../shared/session/agent-descriptors"
import {
  DEFAULT_EXECUTABLE_CHOICE,
  parseExecutableChoice,
} from "../../shared/contracts/agentExecutable"
import { flushSessionPersistence } from "../team/sessionPersistence"
import { networkInterfaces } from "node:os"
import { resolve } from "node:path"

/**
 * Session issuance shared by password login and the first-admin bootstrap.
 * Browser clients get the HttpOnly cookie and never see the token body;
 * machine clients keep the documented bearer-token contract.
 */
export function issueSessionResponse(
  req: IncomingMessage,
  res: ServerResponse,
  browserLogin: boolean,
  principal?: SessionPrincipal,
): Promise<void> {
  const sessionToken = createSessionToken(
    req.socket.remoteAddress || "unknown",
    req.headers["user-agent"],
    principal,
  )
  return (async () => {
    // A team login is not acknowledged until its hashed session row is on
    // disk. This closes the shutdown race where a successful response could
    // otherwise outlive the process without a restart-restorable session.
    if (principal && isTeamEdition()) await flushSessionPersistence()

    if (browserLogin) {
      setBrowserSessionCookie(res, sessionToken)
      sendJson(res, 200, { valid: true })
    } else {
      sendJson(res, 200, { valid: true, token: sessionToken })
    }
  })()
}

/**
 * Team edition authenticates a named user instead of the shared network
 * password; the networkAccess config gate is irrelevant here. Credentials
 * arrive either as `Authorization: Bearer user:pass` (machine clients) or as
 * a `{ username, password }` JSON body (the login form).
 */
async function handleTeamLogin(
  req: IncomingMessage,
  res: ServerResponse,
  browserLogin: boolean,
): Promise<void> {
  const authHeader = req.headers.authorization
  let username: unknown
  let password: unknown
  if (authHeader?.startsWith("Bearer ")) {
    const credentials = authHeader.slice(7)
    const separator = credentials.indexOf(":")
    if (separator === -1) {
      sendJson(res, 401, { valid: false, error: "Username required" })
      return
    }
    username = credentials.slice(0, separator)
    password = credentials.slice(separator + 1)
  } else {
    let body: { username?: unknown; password?: unknown }
    try {
      body = await readJsonBody<{ username?: unknown; password?: unknown }>(req, { allowEmpty: true })
    } catch (error) {
      sendJson(res, error instanceof HttpBodyError ? error.statusCode : 400, {
        valid: false,
        error: error instanceof Error ? error.message : "Invalid request body",
      })
      return
    }
    username = body.username
    password = body.password
  }

  if (typeof username !== "string" || !username.trim()) {
    sendJson(res, 401, { valid: false, error: "Username required" })
    return
  }
  if (typeof password !== "string" || !password) {
    sendJson(res, 401, { valid: false, error: "Password required" })
    return
  }

  const user = getUserByUsername(username)
  const verification = await verifyRemotePassword(password, user?.passwordHash ?? getDummyHash())
  if (verification === "busy") {
    sendJson(res, 429, { valid: false, error: "Authentication is busy. Try again shortly." })
    return
  }
  if (!user || verification === "invalid") {
    sendJson(res, 401, { valid: false, error: "Invalid credentials" })
    return
  }
  const issuance = await withVerifiedUser(user.id, user.passwordHash, async (current) => {
    await issueSessionResponse(req, res, browserLogin, {
      userId: current.id,
      username: current.username,
      role: current.role,
    })
  })
  if (issuance.status === "invalid") {
    sendJson(res, 401, { valid: false, error: "Invalid credentials" })
    return
  }
  // Checked only after password proof, so bad guesses cannot probe status.
  if (issuance.status === "disabled") {
    sendJson(res, 403, { valid: false, error: "Account disabled", code: "ACCOUNT_DISABLED" })
    return
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
      sendJson(res, 200, { enabled: false })
      return
    }
    const host = getLanIp()
    const port = (req.socket.address() as { port?: number })?.port || 19384
    sendJson(res, 200, {
      enabled: true,
      host,
      port,
      url: host ? `http://${host}:${port}` : null,
    })
  })

  // POST /api/auth/verify — public endpoint, validates password and issues session token
  use("/api/auth/verify", async (req, res, next) => {
    if (req.method !== "POST") return next()
    res.setHeader("Cache-Control", "no-store")

    // Direct local clients do not need a network password. Requests forwarded
    // by a loopback reverse proxy remain remote and must authenticate below.
    // Team edition never grants local trust — every login names a user.
    if (!isTeamEdition() && isTrustedDirectLocalRequest(req)) {
      sendJson(res, 200, { valid: true })
      return
    }

    if (!hasTrustedMutationSource(req)) {
      sendJson(res, 403, { valid: false, error: "Untrusted request source" })
      return
    }

    const browserLogin = req.headers["x-cogpit-client"] === "1"
    if (browserLogin && !canIssueBrowserSession(req)) {
      sendJson(res, 426, {
        valid: false,
        error: "Secure HTTPS is required for remote browser access",
      })
      return
    }

    // Rate limit remote auth attempts
    if (isRateLimited(req)) {
      sendJson(res, 429, { valid: false, error: "Too many attempts. Try again in 1 minute." })
      return
    }

    if (isTeamEdition()) {
      await handleTeamLogin(req, res, browserLogin)
      return
    }

    const config = getConfig()
    if (!config?.networkAccess || !config?.networkPassword) {
      sendJson(res, 403, { valid: false, error: "Network access is disabled" })
      return
    }

    const authHeader = req.headers.authorization
    const password = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null

    if (!password) {
      sendJson(res, 401, { valid: false, error: "Password required" })
      return
    }

    const verification = await verifyRemotePassword(password, config.networkPassword)
    if (verification === "busy") {
      sendJson(res, 429, { valid: false, error: "Authentication is busy. Try again shortly." })
      return
    }
    if (verification === "invalid") {
      sendJson(res, 401, { valid: false, error: "Invalid password" })
      return
    }

    const strengthError = validatePasswordStrength(password)
    if (strengthError) {
      sendJson(res, 403, {
        valid: false,
        error: `${strengthError}. Update it from the local Cogpit app.`,
      })
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

    return issueSessionResponse(req, res, browserLogin)
  })

  // GET /api/auth/session — protected by authMiddleware; lets the browser
  // restore its UI state without exposing the HttpOnly token to JavaScript.
  use("/api/auth/session", (req, res, next) => {
    if (req.method !== "GET") return next()
    res.setHeader("Cache-Control", "no-store")
    sendJson(res, 200, { authenticated: true })
  })

  // POST /api/auth/logout — revoke only the current session and expire the
  // browser cookie. Password changes still revoke every session below.
  use("/api/auth/logout", async (req, res, next) => {
    if (req.method !== "POST") return next()
    const token = getRequestSessionToken(req)
    if (token) await revokeSessionToken(token)
    clearBrowserSessionCookie(res)
    res.setHeader("Cache-Control", "no-store")
    sendJson(res, 200, { valid: true })
  })

  // GET /api/connected-devices — list active remote sessions
  use("/api/connected-devices", (req, res, next) => {
    if (req.method !== "GET") return next()
    sendJson(res, 200, { devices: getConnectedDevices() })
  })

  // GET /api/config/validate?path=... - validate a path without saving
  use("/api/config/validate", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const dirPath = url.searchParams.get("path")

    if (!dirPath) {
      sendJson(res, 400, { valid: false, error: "path query param required" })
      return
    }

    sendJson(res, 200, await validateClaudeDir(dirPath))
  })

  // GET /api/config - return current config (or null)
  // POST /api/config - validate and save config
  use("/api/config", async (req, res, next) => {
    if (req.method === "GET") {
      // Only handle exact path
      if (req.url && req.url !== "/" && req.url !== "" && !req.url.startsWith("?")) return next()
      const config = getConfig()
      sendJson(res, 200, config ? {
        claudeDir: config.claudeDir,
        // `mode` is the wire name this field has always had; the agent an
        // unprefixed project belongs to is the same agent an install defaults to.
        mode: config.defaultAgent ?? descriptorForDirName(null).kind,
        networkAccess: config.networkAccess || false,
        networkPassword: config.networkPassword ? "set" : null,
        terminalApp: config.terminalApp || null,
        editorApp: config.editorApp || null,
        useBuiltInEditor: config.useBuiltInEditor || false,
        agentExecutable: config.agentExecutable ?? DEFAULT_EXECUTABLE_CHOICE,
      } : null)
      return
    }

    if (req.method === "POST") {
      withJsonBody<{
        terminalApp?: string
        editorApp?: string
        [key: string]: unknown
      }>(req, res, async (parsed) => {
        const { claudeDir } = parsed
        if (!claudeDir || typeof claudeDir !== "string") {
          sendJson(res, 400, { error: "claudeDir string required" })
          return
        }

        const currentConfig = getConfig()
        const validation = await validateClaudeDir(claudeDir)
        // A bootstrapped install deliberately does not require
        // ~/.claude/projects. Allow saving unrelated settings while that
        // placeholder path is unchanged; any new Claude path must still
        // pass the normal validation above.
        const reusingPlaceholder = currentConfig?.claudeDirIsPlaceholder === true
          && resolve(claudeDir) === resolve(currentConfig.claudeDir)
        if (!validation.valid && !reusingPlaceholder) {
          sendJson(res, 400, { error: validation.error })
          return
        }
        const resolvedClaudeDir = validation.resolved
          || (reusingPlaceholder ? currentConfig.claudeDir : claudeDir)

        // Handle password: new password provided, or keep existing
        let finalPassword = currentConfig?.networkPassword || undefined
        if (parsed.networkPassword && typeof parsed.networkPassword === "string") {
          // Validate password strength
          const strengthError = validatePasswordStrength(parsed.networkPassword)
          if (strengthError) {
            sendJson(res, 400, { error: strengthError })
            return
          }
          // Hash the new password before storing
          finalPassword = hashPassword(parsed.networkPassword)
          // Revoke all existing sessions when password changes
          await revokeAllSessions()
        }

        if (parsed.networkAccess && !finalPassword) {
          sendJson(res, 400, { error: "Password required when enabling network access" })
          return
        }

        // Disabling network access closes the door guests came through, so
        // their live tokens go too. The share records stay: turning network
        // access back on must not silently re-admit anyone.
        if (!parsed.networkAccess && currentConfig?.networkAccess) {
          await revokeAllSessions()
          revokeAllShareTokens()
        }

        await saveConfig({
          claudeDir: resolvedClaudeDir,
          // The preferred agent is a user preference and survives a directory
          // change; only the "never validated" mark is tied to the path.
          defaultAgent: currentConfig?.defaultAgent,
          claudeDirIsPlaceholder: reusingPlaceholder || undefined,
          // The API cannot set the edition (file/env only) but must not drop it.
          edition: currentConfig?.edition
            ?? (getConfiguredEditionValue() === "team" ? "team" : undefined),
          networkAccess: !!parsed.networkAccess,
          networkPassword: finalPassword,
          terminalApp: parsed.terminalApp || undefined,
          editorApp: parsed.editorApp || undefined,
          useBuiltInEditor: !!parsed.useBuiltInEditor,
          agentExecutable: parseExecutableChoice(parsed.agentExecutable),
        })
        refreshDirs()

        // A share record addresses a dirName/fileName inside one projects
        // root. Under a new root that pair is a different session, or none,
        // so every share and its guests go with the old root.
        if (currentConfig && resolve(resolvedClaudeDir) !== resolve(currentConfig.claudeDir)) {
          await clearAllShares()
          revokeAllShareTokens()
        }

        sendJson(res, 200, {
          success: true,
          claudeDir: resolvedClaudeDir,
        })
      })
      return
    }

    next()
  })
}
