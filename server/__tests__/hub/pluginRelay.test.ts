// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("../../config", () => ({ getConfig: () => ({ networkAccess: true, networkPassword: "fixture-network-hash" }) }))
vi.mock("../../team/edition", () => ({ isTeamEdition: () => false }))
import { authMiddleware, createSessionToken, revokeAllSessions, revokeSessionToken } from "../../security"
import { HubPluginRelay, isPluginRelayHeader, type PluginRelayRequest, type PluginRelayResponse } from "../../hub/pluginRelay"
import { invalidateDeviceConnections } from "../../hub/connection-invalidation"
import { PluginAuthorization, PluginAuthorizationError, PLUGIN_SESSION_HEADER } from "../../plugins/authorization"
import { PluginLeaseManager, type PluginLease } from "../../plugins/leases"
import type { HubDevice } from "../../hub/registry"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); await revokeAllSessions(); vi.useRealTimers() })
const body = (value: unknown) => Buffer.from(JSON.stringify(value))
const data = <T>(response: PluginRelayResponse) => JSON.parse(response.body.toString("utf8")) as T

function sourceRequest(token?: string, sessionId?: string): IncomingMessage {
  const req = {
    method: "POST", url: "/api/plugins/session",
    headers: { host: token ? "hub.test" : "localhost", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(sessionId ? { [PLUGIN_SESSION_HEADER]: sessionId } : {}) },
    socket: { remoteAddress: token ? "192.0.2.1" : "127.0.0.1" },
  } as unknown as IncomingMessage
  const next = vi.fn()
  authMiddleware(req, { setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse, next)
  expect(next).toHaveBeenCalledOnce()
  return req
}
const deviceFixture = (): HubDevice => ({ id: "dev_test", name: "Fixture target", host: "127.0.0.1", port: 1, auth: "none", addedAt: 0, connectionRevision: 1 })

async function target(auth: "password" | "none") {
  const authorization = new PluginAuthorization({ hostInstanceId: "target-instance" })
  const leases = new PluginLeaseManager(authorization)
  const leaseRecords = new Map<string, PluginLease>()
  const requests: { url: string; headers: IncomingMessage["headers"] }[] = []
  const serviceToken = auth === "password" ? createSessionToken("127.0.0.1") : null
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: { ...req.headers } })
    authMiddleware(req, res, () => {
      try {
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/api/plugins/session" && req.method === "POST") {
          res.end(JSON.stringify(authorization.createOrRenewSession(req)))
          return
        }
        if (req.url === "/api/plugins/session" && req.method === "DELETE") {
          authorization.revokeSession(req)
          res.end('{"ok":true}')
          return
        }
        const binding = authorization.resolve(req)
        if (req.url === "/api/plugins/leases") {
          const lease = leases.create(binding, { pluginId: "fixture.sample", digest: "a".repeat(64), projectKey: "project-a", contextEpoch: "epoch-a", grantsRevision: 1, connectionRevision: 0 })
          leaseRecords.set(lease.id, lease)
          res.end(JSON.stringify({ id: lease.id, expiresAt: lease.expiresAt }))
          return
        }
        const id = req.url?.match(/^\/api\/plugins\/leases\/([a-f0-9]{64})\/call$/)?.[1]
        if (id) {
          const lease = leases.resolve(binding, id)
          res.end(JSON.stringify({ projectKey: lease.projectKey }))
          return
        }
        if (req.url === "/api/plugins/large") {
          res.end(Buffer.alloc(4 * 1024 * 1024 + 16 * 1024 + 1))
          return
        }
        res.statusCode = 404
        res.end("{}")
      } catch (error) {
        res.statusCode = error instanceof PluginAuthorizationError ? error.status : 500
        res.end(JSON.stringify({ code: error instanceof PluginAuthorizationError ? error.code : "FAILED" }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture listener")
  const device = { ...deviceFixture(), auth, port: address.port }
  const relay = new HubPluginRelay({ getDevice: (id) => id === device.id ? device : undefined, getToken: async () => ({ token: serviceToken, generation: 1 }) })
  cleanup.push(async () => {
    await relay.dispose()
    leases.dispose()
    authorization.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  const mint = async (token?: string) => data<{ sessionId: string; expiresAt: number }>(await relay.request(sourceRequest(token), device.id, "POST", "/api/plugins/session", Buffer.alloc(0)))
  return { device, relay, requests, serviceToken, leaseRecords, mint }
}

describe("hub plugin session relay", () => {
  it.each(["password", "none"] as const)("isolates originating sessions when the target uses %s authentication", async (auth) => {
    const fixture = await target(auth)
    const sourceA = createSessionToken("192.0.2.1"), sourceB = createSessionToken("192.0.2.2")
    const sessionA = await fixture.mint(sourceA), sessionB = await fixture.mint(sourceB)
    const requestA = sourceRequest(sourceA, sessionA.sessionId), requestB = sourceRequest(sourceB, sessionB.sessionId)
    const leaseA = data<{ id: string }>(await fixture.relay.request(requestA, fixture.device.id, "POST", "/api/plugins/leases", Buffer.alloc(0)))
    const leaseB = data<{ id: string }>(await fixture.relay.request(requestB, fixture.device.id, "POST", "/api/plugins/leases", Buffer.alloc(0)))
    const cross = await fixture.relay.request(requestB, fixture.device.id, "POST", `/api/plugins/leases/${leaseA.id}/call`, Buffer.alloc(0))
    expect(cross.status).toBe(409)
    expect(data(cross)).toEqual({ code: "STALE_ACTIVATION" })
    await expect(fixture.relay.request(sourceRequest(sourceB, sessionA.sessionId), fixture.device.id, "GET", "/api/plugins/runtime", Buffer.alloc(0))).rejects.toThrow(/no longer valid/)
    expect(fixture.requests.every((request) => request.headers.authorization === (auth === "password" ? `Bearer ${fixture.serviceToken}` : undefined))).toBe(true)
    expect(JSON.stringify(fixture.requests)).not.toContain(sourceA)
    expect(JSON.stringify(fixture.requests)).not.toContain(sourceB)
    expect(JSON.stringify(fixture.requests)).not.toContain(sessionA.sessionId)
    expect(JSON.stringify(fixture.requests)).not.toContain(sessionB.sessionId)
    await revokeSessionToken(sourceA)
    await vi.waitFor(() => expect(fixture.leaseRecords.get(leaseA.id)?.signal.aborted).toBe(true))
    expect(fixture.leaseRecords.get(leaseB.id)?.signal.aborted).toBe(false)
    expect(fixture.requests.some((request) => request.url === "/api/plugins/session" && request.headers[PLUGIN_SESSION_HEADER])).toBe(true)
  })

  it("supports a trusted-local hub with a trusted-local target and explicit client-session revocation", async () => {
    const fixture = await target("none")
    const session = await fixture.mint()
    const req = sourceRequest(undefined, session.sessionId)
    const lease = data<{ id: string }>(await fixture.relay.request(req, fixture.device.id, "POST", "/api/plugins/leases", Buffer.alloc(0)))
    const renewed = data<{ sessionId: string }>(await fixture.relay.request(req, fixture.device.id, "POST", "/api/plugins/session", Buffer.alloc(0)))
    expect(renewed.sessionId).toBe(session.sessionId)
    expect((await fixture.relay.request(req, fixture.device.id, "DELETE", "/api/plugins/session", Buffer.alloc(0))).status).toBe(200)
    expect(fixture.leaseRecords.get(lease.id)?.signal.aborted).toBe(true)
    await expect(fixture.relay.request(req, fixture.device.id, "POST", "/api/plugins/session", Buffer.alloc(0))).rejects.toThrow(/no longer valid/)
  })

  it("never forwards caller relay headers, origin identity or cookies", async () => {
    const fixture = await target("none")
    const source = createSessionToken("192.0.2.1")
    const req = sourceRequest(source)
    req.headers["x-cogpit-plugin-relay-origin"] = "forged-user"
    req.headers["x-cogpit-relay-session"] = "forged-session"
    req.headers["x-cogpit-principal"] = "admin"
    req.headers.cookie = "private-cookie"
    req.headers.origin = "https://hub.test"
    await fixture.relay.request(req, fixture.device.id, "POST", "/api/plugins/session", Buffer.alloc(0))
    expect(fixture.requests[0]!.headers).not.toHaveProperty("x-cogpit-plugin-relay-origin")
    expect(fixture.requests[0]!.headers).not.toHaveProperty("x-cogpit-relay-session")
    expect(fixture.requests[0]!.headers).not.toHaveProperty("x-cogpit-principal")
    expect(fixture.requests[0]!.headers).not.toHaveProperty("cookie")
    expect(fixture.requests[0]!.headers).not.toHaveProperty("origin")
    expect(isPluginRelayHeader("X-Cogpit-Plugin-Session")).toBe(true)
    expect(isPluginRelayHeader("x-cogpit-relay-anything")).toBe(true)
  })

  it("revokes retained target sessions after device invalidation", async () => {
    const fixture = await target("none")
    const session = await fixture.mint()
    const req = sourceRequest(undefined, session.sessionId)
    const lease = data<{ id: string }>(await fixture.relay.request(req, fixture.device.id, "POST", "/api/plugins/leases", Buffer.alloc(0)))
    invalidateDeviceConnections(fixture.device.id)
    await vi.waitFor(() => expect(fixture.leaseRecords.get(lease.id)?.signal.aborted).toBe(true))
    await expect(fixture.relay.request(req, fixture.device.id, "POST", "/api/plugins/session", Buffer.alloc(0))).rejects.toThrow()
  })

  it("forwards only the two bounded stage metadata headers alongside the translated session", async () => {
    const fixture = await target("none")
    const session = await fixture.mint()
    const req = sourceRequest(undefined, session.sessionId)
    req.headers["x-cogpit-plugin-client"] = '{"appVersion":"2.6.6"}'
    req.headers["x-cogpit-plugin-scope"] = '{"type":"projects","projectIds":[]}'
    req.headers["x-cogpit-plugin-relay-owner"] = "forged-owner"
    req.headers["x-cogpit-plugin-arbitrary"] = "must-not-forward"
    await fixture.relay.request(req, fixture.device.id, "POST", "/api/plugins/stage", body({ bytes: "fixture" }))
    const headers = fixture.requests.at(-1)!.headers
    expect(headers["x-cogpit-plugin-client"]).toBe(req.headers["x-cogpit-plugin-client"])
    expect(headers["x-cogpit-plugin-scope"]).toBe(req.headers["x-cogpit-plugin-scope"])
    expect(headers).not.toHaveProperty("x-cogpit-plugin-relay-owner")
    expect(headers).not.toHaveProperty("x-cogpit-plugin-arbitrary")
    await fixture.relay.request(req, fixture.device.id, "GET", "/api/plugins/runtime", Buffer.alloc(0))
    expect(fixture.requests.at(-1)!.headers).not.toHaveProperty("x-cogpit-plugin-client")
    expect(fixture.requests.at(-1)!.headers).not.toHaveProperty("x-cogpit-plugin-scope")
  })

  it.each(["not JSON", '{"a":1,"a":2}', JSON.stringify("a".repeat(16_384)), '{"a":1}\r\nX-Other: injected'])("rejects malformed or oversized stage metadata before forwarding", async (header) => {
    const fixture = await target("none")
    const session = await fixture.mint()
    const count = fixture.requests.length
    const req = sourceRequest(undefined, session.sessionId)
    req.headers["x-cogpit-plugin-client"] = header
    await expect(fixture.relay.request(req, fixture.device.id, "POST", "/api/plugins/stage", Buffer.alloc(0))).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" })
    expect(fixture.requests).toHaveLength(count)
  })

  it("enforces the real HTTP response byte cap", async () => {
    const fixture = await target("none")
    const session = await fixture.mint()
    await expect(fixture.relay.request(sourceRequest(undefined, session.sessionId), fixture.device.id, "GET", "/api/plugins/large", Buffer.alloc(0))).rejects.toThrow()
  })

  it("rechecks source revocation after asynchronous session mint and revokes a late downstream session", async () => {
    const device = deviceFixture()
    const source = createSessionToken("192.0.2.1")
    let finish!: (value: PluginRelayResponse) => void
    const calls: PluginRelayRequest[] = []
    const relay = new HubPluginRelay({
      getDevice: () => device, getToken: async () => ({ token: null, generation: 1 }),
      transport: async (request) => {
        calls.push(request)
        if (request.method === "DELETE") return { status: 200, contentType: "application/json", body: body({ ok: true }) }
        return await new Promise<PluginRelayResponse>((resolve) => { finish = resolve })
      },
    })
    cleanup.push(() => relay.dispose())
    const pending = relay.request(sourceRequest(source), device.id, "POST", "/api/plugins/session", Buffer.alloc(0))
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await revokeSessionToken(source)
    expect(calls[0]!.signal.aborted).toBe(true)
    finish({ status: 200, contentType: "application/json", body: body({ sessionId: "a".repeat(64), expiresAt: Date.now() + 60_000 }) })
    await expect(pending).rejects.toThrow(/no longer valid/)
    await vi.waitFor(() => expect(calls.some((request) => request.method === "DELETE" && request.sessionId === "a".repeat(64))).toBe(true))
  })

  it("bounds orphan relay sessions by TTL and keeps the original downstream credential on renewal", async () => {
    vi.useFakeTimers()
    let now = Date.now()
    const device = { ...deviceFixture(), auth: "password" as const }
    let tokenCount = 0
    const calls: PluginRelayRequest[] = []
    const relay = new HubPluginRelay({
      now: () => now, getDevice: () => device,
      getToken: async () => ({ token: `device-token-${++tokenCount}`, generation: tokenCount }),
      transport: async (request) => {
        calls.push(request)
        return { status: 200, contentType: "application/json", body: body(request.method === "DELETE" ? { ok: true } : { sessionId: "c".repeat(64), expiresAt: now + 60_000 }) }
      },
    })
    cleanup.push(() => relay.dispose())
    const session = data<{ sessionId: string }>(await relay.request(sourceRequest(), device.id, "POST", "/api/plugins/session", Buffer.alloc(0)))
    now += 10_000
    await relay.request(sourceRequest(undefined, session.sessionId), device.id, "POST", "/api/plugins/session", Buffer.alloc(0))
    expect(tokenCount).toBe(1)
    expect(calls[1]!.token.token).toBe("device-token-1")
    now += 60_001
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.at(-1)!.method).toBe("DELETE")
    await expect(relay.request(sourceRequest(undefined, session.sessionId), device.id, "GET", "/api/plugins/runtime", Buffer.alloc(0))).rejects.toThrow()
  })
})
