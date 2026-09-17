// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const environment = vi.hoisted(() => ({ team: false }))
vi.mock("../../config", () => ({ getConfig: () => ({ networkAccess: true, networkPassword: "fixture-network-hash" }) }))
vi.mock("../../team/edition", () => ({ isTeamEdition: () => environment.team }))
vi.mock("../../team/sessionPersistence", () => ({
  clearAllSessions: async () => {}, persistSession: async () => {}, removeSession: async () => {},
  removeSessionsForUser: async () => {}, restoreSession: () => null, touchSession: async () => {},
}))
import { authMiddleware, createSessionToken, revokeAllSessions, revokeSessionToken, revokeSessionsForUser } from "../../security"
import { getRequestAuthentication, setRequestAuthentication } from "../../requestAuthentication"
import { PluginAuthorization, PLUGIN_SESSION_HEADER, requirePluginAuthentication } from "../../plugins/authorization"
import { PluginLeaseManager, type PluginLeaseScope } from "../../plugins/leases"
import * as security from "../../security"
import { client } from "./fixtures/storeSigning"

const managers: { dispose(): void }[] = []
let now = 1000
function request(token?: string, pluginSession?: string): IncomingMessage {
  return {
    method: "POST", url: "/api/plugins/session",
    headers: { host: token ? "host.test" : "localhost", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(pluginSession ? { [PLUGIN_SESSION_HEADER]: pluginSession } : {}) },
    socket: { remoteAddress: token ? "192.0.2.10" : "127.0.0.1" },
  } as unknown as IncomingMessage
}
function authenticate(req: IncomingMessage): IncomingMessage {
  const next = vi.fn()
  const res = { setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse
  authMiddleware(req, res, next)
  expect(next).toHaveBeenCalledOnce()
  return req
}
function manager() {
  const authorization = new PluginAuthorization({ hostInstanceId: "host-instance-a", now: () => now })
  const leases = new PluginLeaseManager(authorization, { now: () => now })
  managers.push(leases, authorization)
  return { authorization, leases }
}
const scope: PluginLeaseScope = {
  pluginId: "fixture.sample", digest: "a".repeat(64), projectKey: "project-a", contextEpoch: "epoch-a", grantsRevision: 2, connectionRevision: 3,
}

beforeEach(async () => { environment.team = false; now = 1000; await revokeAllSessions() })
afterEach(async () => { for (const entry of managers.splice(0)) entry.dispose(); await revokeAllSessions(); vi.useRealTimers() })

describe("accepted request authentication", () => {
  it("records trusted local admission without treating arbitrary bearer/header identities as authentication", () => {
    const req = request()
    req.headers.authorization = "Bearer caller-invented"
    req.headers["x-cogpit-principal"] = "admin"
    req.headers["x-cogpit-plugin-relay-origin"] = "another-user"
    expect(getRequestAuthentication(req)).toBeNull()
    expect(() => requirePluginAuthentication(req)).toThrow(/authenticated owner/)
    authenticate(req)
    expect(getRequestAuthentication(req)).toEqual({ kind: "local" })
  })

  it("records only a token the middleware actually validated", () => {
    const token = createSessionToken("192.0.2.10")
    const req = authenticate(request(token))
    expect(getRequestAuthentication(req)).toEqual({ kind: "session", token, principal: null })
    const denied = request("invalid")
    const next = vi.fn()
    authMiddleware(denied, { setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse, next)
    expect(next).not.toHaveBeenCalled()
    expect(getRequestAuthentication(denied)).toBeNull()
  })

  it("leaves public requests without an accepted protected authentication marker", () => {
    const req = request()
    setRequestAuthentication(req, { kind: "local" })
    req.url = "/api/hello"
    authenticate(req)
    expect(getRequestAuthentication(req)).toBeNull()
  })

  it("rejects untrusted local browser origins before marking authentication", () => {
    const req = request()
    req.headers.origin = "https://attacker.test"
    const next = vi.fn()
    authMiddleware(req, { setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse, next)
    expect(next).not.toHaveBeenCalled()
    expect(getRequestAuthentication(req)).toBeNull()
  })

  it("uses principal identity from validated team sessions and refuses member access", () => {
    environment.team = true
    const admin = createSessionToken("192.0.2.10", undefined, { userId: "user-a", username: "admin", role: "admin" })
    const member = createSessionToken("192.0.2.10", undefined, { userId: "user-b", username: "member", role: "member" })
    expect(requirePluginAuthentication(authenticate(request(admin))).kind).toBe("session")
    expect(() => requirePluginAuthentication(authenticate(request(member)))).toThrow(/administrator/)
  })
})

describe("plugin client sessions and activation leases", () => {
  it("issues an opaque local client session and snapshots complete lease scope", () => {
    const { authorization, leases } = manager()
    const created = authorization.createOrRenewSession(authenticate(request()))
    expect(created.sessionId).toMatch(/^[a-f0-9]{64}$/)
    expect(created.expiresAt).toBe(now + 60_000)
    const binding = authorization.resolve(authenticate(request(undefined, created.sessionId)))
    const original = { ...scope }
    const lease = leases.create(binding, original)
    original.projectKey = "different"
    expect(lease).toMatchObject({ ...scope, sessionId: created.sessionId, principalId: "owner", hostInstanceId: "host-instance-a", expiresAt: now + 30_000 })
    expect(lease.signal.aborted).toBe(false)
    expect(Object.isFrozen(lease)).toBe(true)
    expect(() => leases.resolve({ ...binding }, lease.id)).toThrow(/no longer valid/)
  })

  it("requires the opaque handle on every subsequent request", () => {
    const { authorization } = manager()
    expect(() => authorization.resolve(authenticate(request()))).toThrow(/no longer valid/)
    expect(() => authorization.resolve(authenticate(request(undefined, "a".repeat(64))))).toThrow(/no longer valid/)
    const malformed = authenticate(request())
    malformed.headers[PLUGIN_SESSION_HEADER] = ["a".repeat(64), "b".repeat(64)]
    expect(() => authorization.createOrRenewSession(malformed)).toThrow(/no longer valid/)
  })

  it("isolates two authentication sessions even when both represent the same administrator", () => {
    environment.team = true
    const principal = { userId: "user-a", username: "admin", role: "admin" as const }
    const tokenA = createSessionToken("192.0.2.1", undefined, principal)
    const tokenB = createSessionToken("192.0.2.2", undefined, principal)
    const { authorization, leases } = manager()
    const sessionA = authorization.createOrRenewSession(authenticate(request(tokenA)))
    const sessionB = authorization.createOrRenewSession(authenticate(request(tokenB)))
    const bindingA = authorization.resolve(authenticate(request(tokenA, sessionA.sessionId)))
    const bindingB = authorization.resolve(authenticate(request(tokenB, sessionB.sessionId)))
    const lease = leases.create(bindingA, scope)
    expect(() => authorization.resolve(authenticate(request(tokenB, sessionA.sessionId)))).toThrow(/no longer valid/)
    expect(() => leases.resolve(bindingB, lease.id)).toThrow(/no longer valid/)
    expect(() => leases.renew(bindingB, lease.id)).toThrow(/no longer valid/)
    expect(() => leases.revoke(bindingB, lease.id)).toThrow(/no longer valid/)
    expect(lease.signal.aborted).toBe(false)
  })

  it("revokes only the originating session's leases on logout, independent of HTTP response lifetime", async () => {
    const tokenA = createSessionToken("192.0.2.1")
    const tokenB = createSessionToken("192.0.2.2")
    const { authorization, leases } = manager()
    const create = (token: string) => {
      const session = authorization.createOrRenewSession(authenticate(request(token)))
      const binding = authorization.resolve(authenticate(request(token, session.sessionId)))
      return { binding, lease: leases.create(binding, scope) }
    }
    const a = create(tokenA), b = create(tokenB)
    await revokeSessionToken(tokenA)
    expect(a.lease.signal.aborted).toBe(true)
    expect(() => leases.resolve(a.binding, a.lease.id)).toThrow()
    expect(leases.resolve(b.binding, b.lease.id).signal.aborted).toBe(false)
  })

  it("uses the existing user demotion/reset revocation source", async () => {
    environment.team = true
    const token = createSessionToken("192.0.2.1", undefined, { userId: "user-a", username: "admin", role: "admin" })
    const { authorization, leases } = manager()
    const session = authorization.createOrRenewSession(authenticate(request(token)))
    const binding = authorization.resolve(authenticate(request(token, session.sessionId)))
    const lease = leases.create(binding, scope)
    await revokeSessionsForUser("user-a")
    expect(lease.signal.aborted).toBe(true)
    expect(() => authorization.assertBinding(binding)).toThrow()
  })

  it("expires leases without a browser request and never extends the client session through lease renewal", () => {
    vi.useFakeTimers()
    const { authorization, leases } = manager()
    const session = authorization.createOrRenewSession(authenticate(request()))
    const req = authenticate(request(undefined, session.sessionId))
    const binding = authorization.resolve(req)
    const lease = leases.create(binding, scope)
    now += 20_000
    expect(leases.renew(binding, lease.id).expiresAt).toBe(now + 30_000)
    expect(binding.expiresAt).toBe(session.expiresAt)
    now += 30_001
    vi.advanceTimersByTime(1000)
    expect(lease.signal.aborted).toBe(true)
    expect(() => leases.renew(binding, lease.id)).toThrow()
  })

  it("renews only live client sessions and bounds leases by the client expiry", () => {
    const { authorization, leases } = manager()
    const session = authorization.createOrRenewSession(authenticate(request()))
    const req = authenticate(request(undefined, session.sessionId))
    const binding = authorization.resolve(req)
    now += 50_000
    expect(leases.create(binding, scope).expiresAt).toBe(session.expiresAt)
    expect(authorization.createOrRenewSession(req).expiresAt).toBe(now + 60_000)
    now += 60_001
    expect(() => authorization.createOrRenewSession(req)).toThrow()
  })

  it("explicit session revocation, scope invalidation and disposal abort operations", () => {
    const { authorization, leases } = manager()
    const session = authorization.createOrRenewSession(authenticate(request()))
    const req = authenticate(request(undefined, session.sessionId))
    const binding = authorization.resolve(req)
    const a = leases.create(binding, scope)
    const b = leases.create(binding, { ...scope, projectKey: "project-b" })
    leases.revokeMatching({ projectKey: "project-a", digest: scope.digest })
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    authorization.revokeSession(req)
    expect(b.signal.aborted).toBe(true)
    authorization.dispose()
    expect(() => authorization.createOrRenewSession(authenticate(request()))).toThrow()
  })

  it("global revocation also cancels trusted-local client sessions", async () => {
    const { authorization, leases } = manager()
    const session = authorization.createOrRenewSession(authenticate(request()))
    const binding = authorization.resolve(authenticate(request(undefined, session.sessionId)))
    const lease = leases.create(binding, scope)
    await revokeAllSessions()
    expect(lease.signal.aborted).toBe(true)
  })
})

describe("connected plugin client descriptors", () => {
  it("keeps detached descriptor snapshots without changing the public session response", () => {
    const { authorization } = manager()
    const descriptor = structuredClone(client)
    const session = authorization.createOrRenewSession(authenticate(request()), descriptor)
    expect(Object.keys(session).sort()).toEqual(["expiresAt", "sessionId"])
    descriptor.appVersion = "9.9.9"
    const active = authorization.activeClients()
    expect(active).toEqual([client])
    active[0].appVersion = "8.8.8"
    ;(active[0].capabilities as Record<string, string>).changed = "1.0.0"
    expect(authorization.activeClients()).toEqual([client])
    expect(authorization.activeClients(session.sessionId)).toEqual([])
    expect(JSON.stringify(active)).not.toContain(session.sessionId)
  })

  it("updates a descriptor on renewal and preserves it for older descriptor-less renewals", () => {
    const { authorization } = manager()
    const session = authorization.createOrRenewSession(authenticate(request()), client)
    const req = authenticate(request(undefined, session.sessionId))
    const changed = { ...client, appVersion: "2.7.0" }
    authorization.createOrRenewSession(req, changed)
    authorization.createOrRenewSession(req)
    authorization.createOrRenewSession(authenticate(request()))
    expect(authorization.activeClients()).toEqual([changed])
  })

  it("rejects invalid descriptor renewal before extending expiry or changing the snapshot", () => {
    const { authorization } = manager()
    const session = authorization.createOrRenewSession(authenticate(request()), client)
    const req = authenticate(request(undefined, session.sessionId))
    now += 10_000
    expect(() => authorization.createOrRenewSession(req, { ...client, apiVersions: ["invalid"] })).toThrow(/Invalid plugin client descriptor/)
    expect(authorization.resolve(req).expiresAt).toBe(session.expiresAt)
    expect(authorization.activeClients()).toEqual([client])
    expect(() => authorization.createOrRenewSession(authenticate(request()), { ...client, capabilities: { token: "secret" } })).toThrow(/Invalid plugin client descriptor/)
    expect(authorization.activeClients()).toEqual([client])
  })

  it("sweeps expired descriptors and removes explicitly revoked or disposed sessions", () => {
    const { authorization } = manager()
    authorization.createOrRenewSession(authenticate(request()), client)
    now += 30_000
    const live = authorization.createOrRenewSession(authenticate(request()), { ...client, appVersion: "2.7.0" })
    now += 30_001
    expect(authorization.activeClients()).toHaveLength(1)
    authorization.revokeSession(authenticate(request(undefined, live.sessionId)))
    expect(authorization.activeClients()).toEqual([])
    authorization.createOrRenewSession(authenticate(request()), client)
    authorization.dispose()
    expect(authorization.activeClients()).toEqual([])
  })

  it("removes descriptors on logout and user demotion revocation", async () => {
    environment.team = true
    const { authorization } = manager()
    const tokenA = createSessionToken("192.0.2.1", undefined, { userId: "user-a", username: "admin-a", role: "admin" })
    const tokenB = createSessionToken("192.0.2.2", undefined, { userId: "user-b", username: "admin-b", role: "admin" })
    authorization.createOrRenewSession(authenticate(request(tokenA)), client)
    authorization.createOrRenewSession(authenticate(request(tokenB)), client)
    await revokeSessionToken(tokenA)
    expect(authorization.activeClients()).toEqual([client])
    await revokeSessionsForUser("user-b")
    expect(authorization.activeClients()).toEqual([])
  })

  it("rechecks a demoted principal even before the revocation notification arrives", () => {
    environment.team = true
    const { authorization } = manager()
    const principal = { userId: "user-a", username: "admin", role: "admin" as const }
    const token = createSessionToken("192.0.2.1", undefined, principal)
    authorization.createOrRenewSession(authenticate(request(token)), client)
    const current = vi.spyOn(security, "getSessionPrincipal").mockReturnValue({ ...principal, role: "member" })
    try { expect(authorization.activeClients()).toEqual([]) }
    finally { current.mockRestore() }
  })

  it("preserves the existing 512-session limit and releases expired capacity", () => {
    const { authorization } = manager()
    for (let index = 0; index < 512; index++) authorization.createOrRenewSession(authenticate(request()), client)
    expect(() => authorization.createOrRenewSession(authenticate(request()), client)).toThrow(/Too many plugin client sessions/)
    expect(authorization.activeClients()).toHaveLength(512)
    now += 60_001
    authorization.createOrRenewSession(authenticate(request()), client)
    expect(authorization.activeClients()).toEqual([client])
  })
})
