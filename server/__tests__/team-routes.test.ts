// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionToken,
  validateSessionToken,
  getSessionPrincipal,
  hashPassword,
  verifyPassword,
  __resetSessionsForTest,
  type SessionPrincipal,
} from "../security"
import { initEdition, __resetEditionForTest } from "../team/edition"
import {
  initUsersStore,
  createUser,
  getUserById,
  getUserByUsername,
  userCount,
  __resetUsersForTest,
} from "../team/users"
import { __resetForTest as __resetSessionPersistenceForTest } from "../team/sessionPersistence"
import { setRequestPrincipal } from "../team/requestPrincipal"
import { requirementFor } from "../team/policy"
import { teamAuthzMiddleware } from "../team/authz"
import { ALL_CAPABILITIES, MEMBER_CAPABILITIES } from "../../shared/contracts/team"
import {
  __resetBootstrapTokenForTest,
  initializeBootstrapToken,
} from "../team/bootstrapToken"

import type { Middleware } from "../helpers"
import { collectRoutes, createMockReqRes, getRouteHandler } from "./http-fixtures"
import { registerTeamAdminRoutes } from "../routes/team"

const STRONG_PASSWORD = "correct-horse-battery-staple"
const SECOND_PASSWORD = "another-long-passphrase"
const BOOTSTRAP_TOKEN = "test-bootstrap-token-at-least-32-characters"
const originalEditionEnv = process.env.COGPIT_EDITION

function enterTeamEdition(): void {
  initEdition({ shell: "standalone", configEdition: "team" })
}

/** Every admin route here is reached from a LAN client holding the bootstrap token. */
function createBootstrapReqRes(method: string, url: string, body?: string) {
  return createMockReqRes(method, url, {
    body,
    remoteAddress: "192.168.1.100",
    headers: { "x-cogpit-bootstrap-token": BOOTSTRAP_TOKEN },
  })
}

let root: string
let handlers: Map<string, Middleware>

beforeEach(async () => {
  delete process.env.COGPIT_EDITION
  root = await mkdtemp(join(tmpdir(), "cogpit-team-routes-"))
  await initUsersStore(join(root, "team"))
  initializeBootstrapToken(0, { COGPIT_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN })
  handlers = collectRoutes(registerTeamAdminRoutes)
})

afterEach(async () => {
  __resetSessionsForTest()
  __resetSessionPersistenceForTest()
  __resetUsersForTest()
  __resetEditionForTest()
  __resetBootstrapTokenForTest()
  if (originalEditionEnv === undefined) delete process.env.COGPIT_EDITION
  else process.env.COGPIT_EDITION = originalEditionEnv
  await rm(root, { recursive: true, force: true })
})

// ── GET /api/me ─────────────────────────────────────────────────────────

describe("GET /api/me", () => {
  it("reports the personal identity with full capabilities", async () => {
    const handler = getRouteHandler(handlers, "/api/me")
    const { req, res, next } = createBootstrapReqRes("GET", "/")

    await handler(req, res, next)

    expect(res._getStatus()).toBe(200)
    expect(JSON.parse(res._getData())).toEqual({
      authenticated: true,
      edition: "personal",
      user: null,
      capabilities: ALL_CAPABILITIES,
    })
  })

  it("reports a team member with member capabilities", async () => {
    enterTeamEdition()
    const bob = await createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" })
    const handler = getRouteHandler(handlers, "/api/me")
    const { req, res, next } = createBootstrapReqRes("GET", "/")
    setRequestPrincipal(req, { userId: bob.id, username: "bob", role: "member" })

    await handler(req, res, next)

    expect(JSON.parse(res._getData())).toEqual({
      authenticated: true,
      edition: "team",
      user: bob,
      capabilities: MEMBER_CAPABILITIES,
    })
  })

  it("reports a team admin with full capabilities", async () => {
    enterTeamEdition()
    const alice = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const handler = getRouteHandler(handlers, "/api/me")
    const { req, res, next } = createBootstrapReqRes("GET", "/")
    setRequestPrincipal(req, { userId: alice.id, username: "alice", role: "admin" })

    await handler(req, res, next)

    expect(JSON.parse(res._getData())).toEqual({
      authenticated: true,
      edition: "team",
      user: alice,
      capabilities: ALL_CAPABILITIES,
    })
  })

  it("calls next for non-GET methods", async () => {
    const handler = getRouteHandler(handlers, "/api/me")
    const { req, res, next } = createBootstrapReqRes("POST", "/")
    await handler(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})

// ── POST /api/team/bootstrap ────────────────────────────────────────────

describe("POST /api/team/bootstrap", () => {
  function bootstrapHandler(): Middleware {
    return getRouteHandler(handlers, "/api/team/bootstrap")
  }

  it("requires the one-time bootstrap token", async () => {
    enterTeamEdition()
    const body = JSON.stringify({ username: "mallory", password: STRONG_PASSWORD })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)
    req.headers["x-cogpit-bootstrap-token"] = "wrong-token"

    const pending = bootstrapHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(403)
    expect(JSON.parse(res._getData())).toMatchObject({ code: "INVALID_BOOTSTRAP_TOKEN" })
    expect(userCount()).toBe(0)
  })

  it("creates the first admin and issues a machine token", async () => {
    enterTeamEdition()
    const body = JSON.stringify({ username: " Alice ", password: STRONG_PASSWORD })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)

    const pending = bootstrapHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(200)
    // The token rides in the body, so no cache may store the response.
    expect(res._getHeaders()["Cache-Control"]).toBe("no-store")
    const payload = JSON.parse(res._getData())
    expect(payload.valid).toBe(true)
    expect(payload.token).toMatch(/^[0-9a-f]{64}$/)

    expect(userCount()).toBe(1)
    const alice = getUserByUsername("alice")
    expect(alice?.role).toBe("admin")
    expect(validateSessionToken(payload.token)).toBe(true)
    expect(getSessionPrincipal(payload.token)).toEqual({
      userId: alice!.id,
      username: "alice",
      role: "admin",
    })
  })

  it("sets the HttpOnly cookie for HTTPS-forwarded browser clients and withholds the token", async () => {
    enterTeamEdition()
    const body = JSON.stringify({ username: "alice", password: STRONG_PASSWORD })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)
    req.headers["x-cogpit-client"] = "1"
    req.headers["x-forwarded-proto"] = "https"

    const pending = bootstrapHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(200)
    expect(JSON.parse(res._getData())).toEqual({ valid: true })
    expect(res._getHeaders()["Set-Cookie"]).toContain("__Host-cogpit_session=")
  })

  it("rejects a plain-HTTP remote browser bootstrap with 426 before creating the admin", async () => {
    enterTeamEdition()
    const body = JSON.stringify({ username: "alice", password: STRONG_PASSWORD })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)
    req.headers["x-cogpit-client"] = "1"
    // Remote socket, no HTTPS forwarding headers: the cookie could never be
    // stored, so the admin must not be created either.

    const pending = bootstrapHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(426)
    expect(JSON.parse(res._getData())).toEqual({
      valid: false,
      error: "Secure HTTPS is required for remote browser access",
    })
    expect(userCount()).toBe(0)
  })

  it("answers 410 once a user exists", async () => {
    enterTeamEdition()
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const body = JSON.stringify({ username: "mallory", password: STRONG_PASSWORD })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)

    const pending = bootstrapHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(410)
    expect(JSON.parse(res._getData())).toEqual({ error: "Already bootstrapped" })
    expect(userCount()).toBe(1)
  })

  it("lets exactly one of two concurrent bootstraps create an admin", async () => {
    enterTeamEdition()
    const a = createBootstrapReqRes("POST", "/", JSON.stringify({ username: "alice", password: STRONG_PASSWORD }))
    const b = createBootstrapReqRes("POST", "/", JSON.stringify({ username: "mallory", password: STRONG_PASSWORD }))

    const handler = bootstrapHandler()
    const pendingA = handler(a.req, a.res, a.next)
    const pendingB = handler(b.req, b.res, b.next)
    a.sendBody()
    b.sendBody()
    await Promise.all([pendingA, pendingB])

    expect([a.res._getStatus(), b.res._getStatus()].sort()).toEqual([200, 410])
    expect(userCount()).toBe(1)
    expect(getUserByUsername("alice")).not.toBeNull()
    expect(getUserByUsername("mallory")).toBeNull()
  })

  it("maps validation failures to 400", async () => {
    enterTeamEdition()
    const body = JSON.stringify({ username: "alice", password: "short" })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)

    const pending = bootstrapHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).error).toContain("16 characters")
    expect(userCount()).toBe(0)
  })

  it("does not exist in personal edition", async () => {
    const body = JSON.stringify({ username: "alice", password: STRONG_PASSWORD })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)

    const pending = bootstrapHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(404)
    expect(userCount()).toBe(0)
  })

  it("calls next for non-POST methods", async () => {
    const { req, res, next } = createBootstrapReqRes("GET", "/")
    await bootstrapHandler()(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})

// ── /api/team/users ─────────────────────────────────────────────────────

describe("/api/team/users", () => {
  function usersHandler(): Middleware {
    return getRouteHandler(handlers, "/api/team/users")
  }

  async function createSessionFor(user: { id: string; username: string; role: "admin" | "member" }) {
    const principal: SessionPrincipal = {
      userId: user.id,
      username: user.username,
      role: user.role,
    }
    return createSessionToken("192.168.1.100", undefined, principal)
  }

  it("lists users without password hashes", async () => {
    enterTeamEdition()
    const alice = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const { req, res, next } = createBootstrapReqRes("GET", "/")

    await usersHandler()(req, res, next)

    expect(res._getStatus()).toBe(200)
    const payload = JSON.parse(res._getData())
    expect(payload.users).toEqual([alice])
    expect(res._getData()).not.toContain("passwordHash")
  })

  it("creates a member and returns the public record", async () => {
    enterTeamEdition()
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const body = JSON.stringify({
      username: "Bob",
      password: STRONG_PASSWORD,
      role: "member",
      displayName: "Bob Builder",
    })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)

    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(200)
    const payload = JSON.parse(res._getData())
    expect(payload.user).toMatchObject({
      username: "bob",
      displayName: "Bob Builder",
      role: "member",
    })
    expect(getUserByUsername("bob")).not.toBeNull()
  })

  it("maps duplicate usernames to 400", async () => {
    enterTeamEdition()
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const body = JSON.stringify({ username: "alice", password: STRONG_PASSWORD, role: "member" })
    const { req, res, next, sendBody } = createBootstrapReqRes("POST", "/", body)

    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).error).toContain("already taken")
  })

  it("disables a user and revokes their sessions", async () => {
    enterTeamEdition()
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const bob = await createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" })
    const token = await createSessionFor({ id: bob.id, username: "bob", role: "member" })
    expect(validateSessionToken(token)).toBe(true)

    const body = JSON.stringify({ disabled: true })
    const { req, res, next, sendBody } = createBootstrapReqRes("PATCH", `/${bob.id}`, body)
    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(200)
    expect(JSON.parse(res._getData()).user.disabled).toBe(true)
    expect(getUserById(bob.id)?.disabled).toBe(true)
    expect(validateSessionToken(token)).toBe(false)
  })

  it("changes a role and revokes that user's sessions", async () => {
    enterTeamEdition()
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const bob = await createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" })
    const token = await createSessionFor({ id: bob.id, username: "bob", role: "member" })

    const body = JSON.stringify({ role: "admin" })
    const { req, res, next, sendBody } = createBootstrapReqRes("PATCH", `/${bob.id}`, body)
    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(200)
    expect(getUserById(bob.id)?.role).toBe("admin")
    expect(validateSessionToken(token)).toBe(false)
  })

  it("resets a password, re-hashes it, and revokes sessions", async () => {
    enterTeamEdition()
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const bob = await createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" })
    const token = await createSessionFor({ id: bob.id, username: "bob", role: "member" })

    const body = JSON.stringify({ password: SECOND_PASSWORD })
    const { req, res, next, sendBody } = createBootstrapReqRes("PATCH", `/${bob.id}`, body)
    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(200)
    expect(verifyPassword(SECOND_PASSWORD, getUserById(bob.id)!.passwordHash)).toBe(true)
    expect(validateSessionToken(token)).toBe(false)
  })

  it("maps last-admin protection to 400 and keeps sessions intact", async () => {
    enterTeamEdition()
    const alice = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const token = await createSessionFor({ id: alice.id, username: "alice", role: "admin" })

    for (const patch of [{ role: "member" }, { disabled: true }]) {
      const { req, res, next, sendBody } = createBootstrapReqRes(
        "PATCH", `/${alice.id}`, JSON.stringify(patch),
      )
      const pending = usersHandler()(req, res, next)
      sendBody()
      await pending

      expect(res._getStatus()).toBe(400)
      expect(JSON.parse(res._getData()).error).toBe("Cannot remove the last admin")
    }
    expect(validateSessionToken(token)).toBe(true)
  })

  it("answers 404 for an unknown user id", async () => {
    enterTeamEdition()
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const { req, res, next, sendBody } = createBootstrapReqRes(
      "PATCH", "/u_missing", JSON.stringify({ disabled: true }),
    )

    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(404)
  })

  it("applies nothing from a mixed patch whose password is weak", async () => {
    enterTeamEdition()
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const bob = await createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" })
    const token = await createSessionFor({ id: bob.id, username: "bob", role: "member" })

    const body = JSON.stringify({ role: "admin", password: "short" })
    const { req, res, next, sendBody } = createBootstrapReqRes("PATCH", `/${bob.id}`, body)
    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).error).toContain("16 characters")
    // 400 must mean nothing changed: role intact, sessions not revoked.
    expect(getUserById(bob.id)?.role).toBe("member")
    expect(validateSessionToken(token)).toBe(true)
  })

  it("applies nothing from a mixed patch that would end up without an enabled admin", async () => {
    enterTeamEdition()
    // A store whose only admin is disabled. The API refuses to create this
    // state (it never disables the last enabled admin), but an edited or
    // restored users.json can hold it — and re-enabling that admin while
    // demoting them in one patch is exactly what must not half-apply.
    await writeFile(join(root, "team", "users.json"), JSON.stringify({
      users: [
        {
          id: "u_alice", username: "alice", displayName: "alice", role: "admin",
          createdAt: 1, disabled: true, passwordHash: hashPassword(STRONG_PASSWORD),
        },
        {
          id: "u_bob", username: "bob", displayName: "bob", role: "member",
          createdAt: 2, passwordHash: hashPassword(STRONG_PASSWORD),
        },
      ],
    }))
    await initUsersStore(join(root, "team"))

    const body = JSON.stringify({ disabled: false, role: "member" })
    const { req, res, next, sendBody } = createBootstrapReqRes("PATCH", "/u_alice", body)
    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).error).toBe("Cannot remove the last admin")
    expect(getUserById("u_alice")).toMatchObject({ disabled: true, role: "admin" })
  })

  it("still enables a disabled admin when the patch leaves them an admin", async () => {
    enterTeamEdition()
    await writeFile(join(root, "team", "users.json"), JSON.stringify({
      users: [{
        id: "u_alice", username: "alice", displayName: "alice", role: "admin",
        createdAt: 1, disabled: true, passwordHash: hashPassword(STRONG_PASSWORD),
      }],
    }))
    await initUsersStore(join(root, "team"))

    const { req, res, next, sendBody } = createBootstrapReqRes(
      "PATCH", "/u_alice", JSON.stringify({ disabled: false }),
    )
    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(200)
    expect(getUserById("u_alice")?.disabled).toBeUndefined()
  })

  it("maps a weak password reset to 400", async () => {
    enterTeamEdition()
    const alice = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const { req, res, next, sendBody } = createBootstrapReqRes(
      "PATCH", `/${alice.id}`, JSON.stringify({ password: "short" }),
    )

    const pending = usersHandler()(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(400)
    expect(verifyPassword(STRONG_PASSWORD, getUserById(alice.id)!.passwordHash)).toBe(true)
  })

  it("does not exist in personal edition", async () => {
    const { req, res, next } = createBootstrapReqRes("GET", "/")
    await usersHandler()(req, res, next)
    expect(res._getStatus()).toBe(404)
  })
})

// ── Policy coverage ─────────────────────────────────────────────────────

describe("team-admin route policy", () => {
  it("declares the expected requirements", () => {
    expect(requirementFor("/api/me", "GET")).toBe("authed")
    expect(requirementFor("/api/team/bootstrap", "POST")).toBe("public")
    expect(requirementFor("/api/team/users", "GET")).toBe("admin")
    expect(requirementFor("/api/team/users/u_abc", "PATCH")).toBe("admin")
  })

  function runAuthz(url: string, opts: { method?: string; principal?: SessionPrincipal } = {}) {
    const req = {
      url,
      method: opts.method ?? "GET",
      headers: {},
    } as unknown as IncomingMessage
    if (opts.principal) setRequestPrincipal(req, opts.principal)
    let statusCode = 200
    const res = {
      get statusCode() { return statusCode },
      set statusCode(v: number) { statusCode = v },
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse
    const next = vi.fn()
    teamAuthzMiddleware(req, res, next)
    return { next, get statusCode() { return statusCode } }
  }

  it("keeps members out of user management but admits admins", () => {
    enterTeamEdition()
    const member: SessionPrincipal = { userId: "u-m", username: "bob", role: "member" }
    const admin: SessionPrincipal = { userId: "u-a", username: "alice", role: "admin" }

    const rejected = runAuthz("/api/team/users", { principal: member })
    expect(rejected.next).not.toHaveBeenCalled()
    expect(rejected.statusCode).toBe(403)

    expect(runAuthz("/api/team/users", { principal: admin }).next).toHaveBeenCalledOnce()
    expect(runAuthz("/api/me", { principal: member }).next).toHaveBeenCalledOnce()
    expect(runAuthz("/api/team/bootstrap", { method: "POST" }).next).toHaveBeenCalledOnce()
  })
})
