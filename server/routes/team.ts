import type { IncomingMessage, ServerResponse } from "node:http"
import { HttpBodyError, readJsonBody, sendJson, type UseFn } from "../http"
import { canIssueBrowserSession, revokeSessionsForUser, validatePasswordStrength } from "../helpers"
import { type MeResponse, type TeamRole } from "../../shared/contracts/team"
import { computeCapabilities } from "../team/capabilities"
import { getEdition, isTeamEdition } from "../team/edition"
import { getRequestPrincipal } from "../team/requestPrincipal"
import {
  createUser,
  getUserById,
  listUsers,
  setUserDisabled,
  setUserPassword,
  setUserRole,
  toPublicUser,
  userCount,
  UserValidationError,
  validateUserChanges,
} from "../team/users"
import { issueSessionResponse } from "./config"
import {
  BOOTSTRAP_TOKEN_HEADER,
  consumeBootstrapToken,
  verifyBootstrapToken,
} from "../team/bootstrapToken"

interface UserPayload {
  username?: unknown
  password?: unknown
  displayName?: unknown
  role?: unknown
  disabled?: unknown
}

async function readBodyOrRespond(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<UserPayload | null> {
  try {
    return await readJsonBody<UserPayload>(req)
  } catch (error) {
    const status = error instanceof HttpBodyError ? error.statusCode : 400
    sendJson(res, status, {
      error: error instanceof Error ? error.message : "Invalid request body",
    })
    return null
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// Serializes bootstrap attempts. authMiddleware's zero-user carve-out admits
// every concurrent first-run request, so the user count must be re-checked one
// attempt at a time or two racing calls could both create admins.
let bootstrapQueue: Promise<void> = Promise.resolve()

function enqueueBootstrap(operation: () => Promise<void>): Promise<void> {
  const result = bootstrapQueue.then(operation)
  // A rejected operation belongs to its caller. Keep a handled tail so later
  // operations still run rather than inheriting the rejection.
  bootstrapQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function registerTeamAdminRoutes(use: UseFn) {
  // GET /api/me — who am I and what may the UI show. Public identity shape for
  // personal edition; principal-derived for team.
  use("/api/me", (req, res, next) => {
    if (req.method !== "GET") return next()
    const edition = getEdition()
    if (edition === "personal") {
      const me: MeResponse = {
        authenticated: true,
        edition,
        user: null,
        capabilities: computeCapabilities(null, edition),
      }
      return sendJson(res, 200, me)
    }
    const principal = getRequestPrincipal(req)
    const user = principal ? getUserById(principal.userId) : null
    const me: MeResponse = {
      authenticated: user !== null,
      edition,
      user: user ? toPublicUser(user) : null,
      capabilities: computeCapabilities(principal, edition),
    }
    sendJson(res, 200, me)
  })

  // POST /api/team/bootstrap — create the first admin and log them in.
  // authMiddleware only admits this unauthenticated while the users store is
  // initialized and empty, and it already screens the mutation source.
  use("/api/team/bootstrap", async (req, res, next) => {
    if (req.method !== "POST") return next()
    if (!isTeamEdition()) {
      return sendJson(res, 404, { error: "Team edition only" })
    }
    // Session material can ride in the response body for machine clients, so
    // no cache may store it — same rule as /api/auth/verify.
    res.setHeader("Cache-Control", "no-store")

    if (!verifyBootstrapToken(req.headers[BOOTSTRAP_TOKEN_HEADER])) {
      return sendJson(res, 403, {
        error: "Valid bootstrap token required. Open the one-time setup URL shown in the server log.",
        code: "INVALID_BOOTSTRAP_TOKEN",
      })
    }

    // Mirror login's HTTPS gate: a plain-HTTP remote browser cannot store the
    // session cookie, so reject before the admin is created rather than
    // strand a bootstrapped-but-unauthenticated founder.
    const browserLogin = req.headers["x-cogpit-client"] === "1"
    if (browserLogin && !canIssueBrowserSession(req)) {
      return sendJson(res, 426, {
        valid: false,
        error: "Secure HTTPS is required for remote browser access",
      })
    }

    const body = await readBodyOrRespond(req, res)
    if (body === null) return

    await enqueueBootstrap(async () => {
      if (userCount() > 0) {
        return sendJson(res, 410, { error: "Already bootstrapped" })
      }
      try {
        const user = await createUser({
          username: asString(body.username),
          password: asString(body.password),
          displayName: typeof body.displayName === "string" ? body.displayName : undefined,
          role: "admin",
        })
        consumeBootstrapToken()
        await issueSessionResponse(req, res, browserLogin, {
          userId: user.id,
          username: user.username,
          role: user.role,
        })
      } catch (error) {
        if (error instanceof UserValidationError) {
          return sendJson(res, 400, { error: error.message })
        }
        throw error
      }
    })
  })

  // GET  /api/team/users      — list (admin-only via ROUTE_POLICIES)
  // POST /api/team/users      — create
  // PATCH /api/team/users/:id — disable/enable, role change, password reset
  use("/api/team/users", async (req, res, next) => {
    const path = (req.url || "/").split("?")[0]
    const isCollection = path === "/" || path === ""
    const method = req.method || "GET"

    if (isCollection && method === "GET") {
      if (!isTeamEdition()) return sendJson(res, 404, { error: "Team edition only" })
      return sendJson(res, 200, { users: listUsers() })
    }

    if (isCollection && method === "POST") {
      if (!isTeamEdition()) return sendJson(res, 404, { error: "Team edition only" })
      const body = await readBodyOrRespond(req, res)
      if (body === null) return
      try {
        const user = await createUser({
          username: asString(body.username),
          password: asString(body.password),
          displayName: typeof body.displayName === "string" ? body.displayName : undefined,
          role: asString(body.role) as TeamRole,
        })
        return sendJson(res, 200, { user })
      } catch (error) {
        if (error instanceof UserValidationError) {
          return sendJson(res, 400, { error: error.message })
        }
        throw error
      }
    }

    if (!isCollection && method === "PATCH") {
      if (!isTeamEdition()) return sendJson(res, 404, { error: "Team edition only" })
      const id = decodeURIComponent(path.slice(1))
      if (id.includes("/")) return next()
      if (!getUserById(id)) return sendJson(res, 404, { error: "User not found" })

      const body = await readBodyOrRespond(req, res)
      if (body === null) return
      if (body.disabled !== undefined && typeof body.disabled !== "boolean") {
        return sendJson(res, 400, { error: "disabled must be a boolean" })
      }
      if (body.role !== undefined && body.role !== "admin" && body.role !== "member") {
        return sendJson(res, 400, { error: "Role must be admin or member" })
      }
      if (body.password !== undefined && typeof body.password !== "string") {
        return sendJson(res, 400, { error: "Password must be a string" })
      }
      // A mixed payload is all-or-nothing, and the mutations below persist one
      // field at a time — so every rule the payload could trip is checked here,
      // against the combined result, before any of it is applied.
      if (typeof body.password === "string") {
        const strengthError = validatePasswordStrength(body.password)
        if (strengthError) return sendJson(res, 400, { error: strengthError })
      }
      const changeError = validateUserChanges(id, {
        disabled: typeof body.disabled === "boolean" ? body.disabled : undefined,
        role: body.role === "admin" || body.role === "member" ? body.role : undefined,
      })
      if (changeError) return sendJson(res, 400, { error: changeError })

      try {
        // Every applied change invalidates that user's live sessions: a
        // disabled user must drop off immediately, and role/password changes
        // must force a fresh login under the new identity facts.
        if (typeof body.disabled === "boolean") {
          await setUserDisabled(id, body.disabled)
          if (body.disabled) await revokeSessionsForUser(id)
        }
        if (body.role === "admin" || body.role === "member") {
          await setUserRole(id, body.role)
          await revokeSessionsForUser(id)
        }
        if (typeof body.password === "string") {
          await setUserPassword(id, body.password)
          await revokeSessionsForUser(id)
        }
      } catch (error) {
        if (error instanceof UserValidationError) {
          return sendJson(res, 400, { error: error.message })
        }
        throw error
      }

      const updated = getUserById(id)
      return sendJson(res, 200, { user: updated ? toPublicUser(updated) : null })
    }

    next()
  })
}
