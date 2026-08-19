// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  authMiddleware,
  websocketUpgradeRejection,
  createSessionToken,
  __resetSessionsForTest,
  type SessionPrincipal,
} from "../security"
import { getConfig } from "../config"
import { initEdition, __resetEditionForTest } from "../team/edition"
import { initUsersStore, createUser, __resetUsersForTest } from "../team/users"
import { __resetForTest as __resetSessionPersistenceForTest } from "../team/sessionPersistence"
import { getRequestPrincipal } from "../team/requestPrincipal"

vi.mock("../config", () => ({ getConfig: vi.fn() }))

const mockedGetConfig = vi.mocked(getConfig)

const STRONG_PASSWORD = "correct-horse-battery-staple"
const UA = "Browser/1"
const REMOTE_IP = "192.168.1.100"

const originalEditionEnv = process.env.COGPIT_EDITION

let root: string

function enterTeamEdition(): void {
  initEdition({ shell: "standalone", configEdition: "team" })
}

async function createPrincipal(
  username: string,
  role: "admin" | "member",
): Promise<SessionPrincipal> {
  const user = await createUser({ username, password: STRONG_PASSWORD, role })
  return { userId: user.id, username: user.username, role: user.role }
}

beforeEach(async () => {
  delete process.env.COGPIT_EDITION
  // Team edition must never consult the network-access config; a null config
  // means the personal path would answer 403 "Network access is disabled".
  mockedGetConfig.mockReturnValue(null)
  root = await mkdtemp(join(tmpdir(), "cogpit-team-auth-"))
  await initUsersStore(join(root, "team"))
})

afterEach(async () => {
  __resetSessionsForTest()
  __resetSessionPersistenceForTest()
  __resetUsersForTest()
  __resetEditionForTest()
  if (originalEditionEnv === undefined) delete process.env.COGPIT_EDITION
  else process.env.COGPIT_EDITION = originalEditionEnv
  await rm(root, { recursive: true, force: true })
})

interface RequestOptions {
  ip?: string
  host?: string
  method?: string
  authHeader?: string
  cookie?: string
  userAgent?: string
  origin?: string
  forwardedFor?: string
}

function mockReq(url: string, opts: RequestOptions = {}): IncomingMessage {
  const ip = opts.ip ?? "127.0.0.1"
  const headers: Record<string, string> = {
    host: opts.host ?? (ip === "127.0.0.1" ? "127.0.0.1:19384" : "cogpit.local:19384"),
  }
  if (opts.authHeader) headers.authorization = opts.authHeader
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.userAgent) headers["user-agent"] = opts.userAgent
  if (opts.origin) headers.origin = opts.origin
  if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor
  return {
    socket: { remoteAddress: ip },
    url,
    method: opts.method ?? "GET",
    headers,
  } as unknown as IncomingMessage
}

function mockRes(): { res: ServerResponse; body: string; statusCode: number } {
  let body = ""
  let statusCode = 200
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn(),
    end: (data?: string) => { body = data || "" },
  } as unknown as ServerResponse
  return { res, get body() { return body }, get statusCode() { return statusCode } }
}

function run(url: string, opts: RequestOptions = {}) {
  const req = mockReq(url, opts)
  const mock = mockRes()
  const next = vi.fn()
  authMiddleware(req, mock.res, next)
  return { req, next, get statusCode() { return mock.statusCode }, get body() { return mock.body } }
}

// ── authMiddleware: the trust-model flip ────────────────────────────────

describe("authMiddleware (team edition)", () => {
  it("rejects an unauthenticated trusted-local GET /api/projects with 401", () => {
    enterTeamEdition()
    const r = run("/api/projects")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
    expect(r.body).toContain("Authentication required")
  })

  it("requires auth for /api/notifications even from trusted local", () => {
    // The old /api/notify agent-hook carve-out is gone — notifications are
    // raised server-side now, so no unauthenticated ingest survives.
    enterTeamEdition()
    const r = run("/api/notifications", { method: "GET" })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("keeps /api/hello public", () => {
    enterTeamEdition()
    const r = run("/api/hello", { ip: REMOTE_IP })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("keeps static asset paths reachable so the login page can load", () => {
    enterTeamEdition()
    const r = run("/index.html", { ip: REMOTE_IP })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("lets /api/team/bootstrap through while no users exist", () => {
    enterTeamEdition()
    const r = run("/api/team/bootstrap", { method: "POST", ip: REMOTE_IP })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("closes /api/team/bootstrap once a user exists", async () => {
    enterTeamEdition()
    await createPrincipal("alice", "admin")
    const r = run("/api/team/bootstrap", { method: "POST", ip: REMOTE_IP })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("rejects a cross-origin /api/team/bootstrap POST even while no users exist", () => {
    // First-admin takeover: a cross-site page in the browser of anyone who can
    // reach the box must not be able to bootstrap during the zero-users window.
    enterTeamEdition()
    const r = run("/api/team/bootstrap", {
      method: "POST",
      ip: REMOTE_IP,
      origin: "https://evil.example",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Untrusted request source")
  })

  it("keeps /api/team/bootstrap closed until the users store is initialized", async () => {
    // Before initUsersStore runs, userCount() === 0 even with users on disk —
    // a boot-ordering regression must not reopen the bootstrap window.
    enterTeamEdition()
    __resetUsersForTest()
    const closed = run("/api/team/bootstrap", { method: "POST", ip: REMOTE_IP })
    expect(closed.next).not.toHaveBeenCalled()
    expect(closed.statusCode).toBe(401)

    await initUsersStore(join(root, "team"))
    const open = run("/api/team/bootstrap", { method: "POST", ip: REMOTE_IP })
    expect(open.next).toHaveBeenCalledOnce()
  })

  it("keeps the untrusted-loopback 403 ahead of the bootstrap carve-out", () => {
    // DNS rebinding: loopback socket, attacker-controlled Host, zero users.
    enterTeamEdition()
    const r = run("/api/team/bootstrap", { method: "POST", host: "attacker.example:19384" })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Untrusted local host")
  })

  it("authenticates a bearer token and attaches the principal to the request", async () => {
    enterTeamEdition()
    const principal = await createPrincipal("alice", "admin")
    const token = createSessionToken(REMOTE_IP, undefined, principal)
    const r = run("/api/projects", { ip: REMOTE_IP, authHeader: `Bearer ${token}` })
    expect(r.next).toHaveBeenCalledOnce()
    expect(getRequestPrincipal(r.req)).toEqual(principal)
  })

  it("authenticates a trusted-local request by token too", async () => {
    enterTeamEdition()
    const principal = await createPrincipal("alice", "member")
    const token = createSessionToken("127.0.0.1", undefined, principal)
    const r = run("/api/projects", { authHeader: `Bearer ${token}` })
    expect(r.next).toHaveBeenCalledOnce()
    expect(getRequestPrincipal(r.req)).toEqual(principal)
  })

  it("rejects a valid session token that carries no principal", () => {
    enterTeamEdition()
    const token = createSessionToken(REMOTE_IP)
    const r = run("/api/projects", { ip: REMOTE_IP, authHeader: `Bearer ${token}` })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("still binds a browser cookie session to its original user agent", async () => {
    enterTeamEdition()
    const principal = await createPrincipal("alice", "admin")
    const token = createSessionToken(REMOTE_IP, UA, principal)
    const r = run("/api/projects", {
      ip: REMOTE_IP,
      cookie: `__Host-cogpit_session=${token}`,
      userAgent: "Attacker/1",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("ignores networkAccess:false and still authenticates by token", async () => {
    enterTeamEdition()
    mockedGetConfig.mockReturnValue({ claudeDir: "/tmp/claude", networkAccess: false })
    const principal = await createPrincipal("alice", "admin")
    const token = createSessionToken(REMOTE_IP, undefined, principal)
    const r = run("/api/projects", { ip: REMOTE_IP, authHeader: `Bearer ${token}` })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("still rejects cross-origin mutations from authenticated clients", async () => {
    enterTeamEdition()
    const principal = await createPrincipal("alice", "admin")
    const token = createSessionToken(REMOTE_IP, undefined, principal)
    const r = run("/api/send-message", {
      ip: REMOTE_IP,
      method: "POST",
      authHeader: `Bearer ${token}`,
      origin: "https://attacker.example",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Untrusted request source")
  })
})

// ── websocketUpgradeRejection: PTY is admin-only ────────────────────────

describe("websocketUpgradeRejection (team edition)", () => {
  function upgradeReq(headers: Record<string, string>, ip = "127.0.0.1"): IncomingMessage {
    return {
      headers,
      socket: { remoteAddress: ip },
    } as unknown as IncomingMessage
  }

  it("rejects a trusted-local upgrade without a token", () => {
    enterTeamEdition()
    const req = upgradeReq({ host: "localhost:19384" })
    expect(websocketUpgradeRejection(req, new URL("http://localhost/__pty"))).toBe(401)
  })

  it("rejects a member token with 403 (PTY is admin-only)", async () => {
    enterTeamEdition()
    const member = await createPrincipal("bob", "member")
    const token = createSessionToken(REMOTE_IP, undefined, member)
    const req = upgradeReq({ host: "cogpit.local:19384" }, REMOTE_IP)
    expect(
      websocketUpgradeRejection(req, new URL(`http://cogpit.local/__pty?token=${token}`)),
    ).toBe(403)
  })

  it("admits an admin token without any networkAccess config gate", async () => {
    enterTeamEdition()
    mockedGetConfig.mockReturnValue({ claudeDir: "/tmp/claude", networkAccess: false })
    const admin = await createPrincipal("alice", "admin")
    const token = createSessionToken(REMOTE_IP, undefined, admin)
    const req = upgradeReq({ host: "cogpit.local:19384" }, REMOTE_IP)
    expect(
      websocketUpgradeRejection(req, new URL(`http://cogpit.local/__pty?token=${token}`)),
    ).toBeNull()
  })

  it("rejects a principal-less token with 403", () => {
    enterTeamEdition()
    const token = createSessionToken(REMOTE_IP)
    const req = upgradeReq({ host: "cogpit.local:19384" }, REMOTE_IP)
    expect(
      websocketUpgradeRejection(req, new URL(`http://cogpit.local/__pty?token=${token}`)),
    ).toBe(403)
  })

  it("admits a same-origin browser upgrade with an admin session cookie", async () => {
    enterTeamEdition()
    const admin = await createPrincipal("alice", "admin")
    const token = createSessionToken(REMOTE_IP, UA, admin)
    const req = upgradeReq({
      host: "cogpit.example",
      origin: "https://cogpit.example",
      cookie: `__Host-cogpit_session=${token}`,
      "user-agent": UA,
      "x-forwarded-proto": "https",
    })
    expect(websocketUpgradeRejection(req, new URL("https://cogpit.example/__pty"))).toBeNull()
  })
})

// ── Personal edition: the whole branch must be a no-op ──────────────────

describe("personal edition (regression pin)", () => {
  it("keeps trusted-local requests trusted and attaches no principal", () => {
    const r = run("/api/projects")
    expect(r.next).toHaveBeenCalledOnce()
    expect(getRequestPrincipal(r.req)).toBeNull()
  })

  it("keeps the trusted-local websocket bypass", () => {
    const req = {
      headers: { host: "127.0.0.1:19384" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage
    expect(websocketUpgradeRejection(req, new URL("http://localhost/__pty"))).toBeNull()
  })
})
