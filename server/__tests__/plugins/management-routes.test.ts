// @vitest-environment node
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const environment = vi.hoisted(() => ({ team: false, paths: [] as string[] }))
vi.mock("../../config", () => ({ getConfig: () => ({ networkAccess: true, networkPassword: "fixture-network-hash" }) }))
vi.mock("../../team/edition", () => ({ isTeamEdition: () => environment.team }))
vi.mock("../../team/sessionPersistence", () => ({ clearAllSessions: async () => {}, persistSession: async () => {}, removeSession: async () => {}, removeSessionsForUser: async () => {}, restoreSession: () => null, touchSession: async () => {} }))
vi.mock("../../agents", () => ({ allStores: () => [{ listProjects: async () => environment.paths.map((path) => ({ dirName: "fixture", path, sessionCount: 1, lastModified: null })) }] }))
import { authMiddleware, createSessionToken, revokeAllSessions, revokeSessionToken } from "../../security"
import { teamAuthzMiddleware } from "../../team/authz"
import type { Middleware } from "../../http"
import { registerPluginRoutes } from "../../routes/plugins"
import { initializePluginManager, type PluginManager } from "../../plugins/manager"
import { PLUGIN_SESSION_HEADER } from "../../plugins/authorization"
import { PACKAGE_LIMITS } from "../../plugins/package"
import { createAuthority, createRoot, type Authority } from "./fixtures/signing"
import { client, signedPackage } from "./fixtures/storeSigning"
import type { PluginInstallPreview, PluginScope } from "../../../shared/contracts/plugins"

let directory: string
let manager: PluginManager
let handler: Middleware
let authority: Authority
let session: string
const opened: PluginManager[] = []

function captureRoutes(): Middleware {
  let captured: Middleware | undefined
  registerPluginRoutes((_path, route) => { captured = route })
  return captured!
}
interface Options { token?: string; session?: string | null; body?: Buffer | object; headers?: Record<string, string>; handler?: Middleware }
async function call(method: string, path: string, options: Options = {}) {
  const payload = options.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(options.body) ? options.body : Buffer.from(JSON.stringify(options.body))
  const req = Readable.from(payload.length ? [payload] : []) as unknown as IncomingMessage
  Object.assign(req, {
    method, url: `/api/plugins${path}`, headers: {
      host: options.token ? "host.test" : "localhost",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...((options.session === undefined ? session : options.session) ? { [PLUGIN_SESSION_HEADER]: options.session ?? session } : {}),
      ...options.headers,
    }, socket: { remoteAddress: options.token ? "192.0.2.1" : "127.0.0.1" },
  })
  const response = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: vi.fn(), end: vi.fn(), destroy: vi.fn() })
  let admitted = false
  authMiddleware(req, response as unknown as ServerResponse, () => teamAuthzMiddleware(req, response as unknown as ServerResponse, () => { admitted = true }))
  if (admitted) {
    req.url = path
    await (options.handler ?? handler)(req, response as unknown as ServerResponse, vi.fn())
  }
  const raw = response.end.mock.calls.at(-1)?.[0] as string | Buffer | undefined
  let data: any
  try { data = JSON.parse(String(raw)) } catch { data = raw }
  return { status: response.statusCode, data, raw, response, req }
}

async function stage(scope: PluginScope = { type: "all" }, options: Options = {}) {
  return call("POST", "/stage", { ...options, body: signedPackage(authority).bytes, headers: {
    "content-type": "application/octet-stream", "x-cogpit-plugin-client": JSON.stringify(client), "x-cogpit-plugin-scope": JSON.stringify(scope), ...options.headers,
  } })
}
async function install(scope: PluginScope = { type: "all" }): Promise<PluginInstallPreview> {
  const staged = await stage(scope)
  expect(staged.status).toBe(200)
  const preview = staged.data as PluginInstallPreview
  expect((await call("GET", `/payload/${preview.transactionId}`)).status).toBe(200)
  expect((await call("POST", `/transactions/${preview.transactionId}/trial`)).status).toBe(200)
  expect((await call("POST", `/transactions/${preview.transactionId}/commit`, { body: { expectedRevision: preview.registryRevision } })).status).toBe(200)
  return preview
}
async function lease(projectId: string | null = null) {
  return call("POST", "/leases", { body: { pluginId: "dev-test.probe", projectId, contextEpoch: "epoch-a", client } })
}

beforeEach(async () => {
  environment.team = false
  environment.paths = []
  vi.stubEnv("COGPIT_DISABLE_PLUGINS", "0")
  directory = await mkdtemp(join(tmpdir(), "cogpit-plugin-manager-"))
  manager = await initializePluginManager(directory)
  opened.push(manager)
  handler = captureRoutes()
  session = ""
  const created = await call("POST", "/session", { session: null })
  expect(created.status).toBe(200)
  session = created.data.sessionId
  authority = createAuthority()
  const root = createRoot(authority)
  const enrolled = await call("POST", "/publishers", { body: { publisher: "dev-test", label: "Fixture developer", root: root.toString("utf8"), fingerprint: createHash("sha256").update(root).digest("hex"), development: true } })
  expect(enrolled.status).toBe(200)
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const value of opened.splice(0)) await value.close()
  await revokeAllSessions()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe("plugin management routes with the real manager and store", () => {
  it("reports incompatible active clients during review without exposing their sessions", async () => {
    const other = await call("POST", "/session", { session: null, body: { client: { ...client, apiVersions: ["0.1.0"] } } })
    expect(other.status).toBe(200)
    const preview = await stage()
    expect(preview.status).toBe(200)
    expect(preview.data.incompatibleClients).toEqual(["Cogpit 2.6 · API 0.1"])
    expect(JSON.stringify(preview.data)).not.toContain(other.data.sessionId)
    await call("DELETE", "/session", { session: other.data.sessionId })
    expect((await stage()).data.incompatibleClients).toBeUndefined()
  })

  it("rejects malformed session descriptors while retaining body-less client support", async () => {
    expect((await call("POST", "/session", { body: { client: { appVersion: "garbage" } } })).status).toBe(400)
    expect((await call("POST", "/session", { body: { unexpected: true } })).status).toBe(400)
    expect((await call("POST", "/session", { body: Buffer.alloc(16_385) })).status).toBe(413)
    expect((await call("POST", "/session")).status).toBe(200)
  })

  it("requires authenticated administration plus the correct plugin client session", async () => {
    expect((await call("GET", "/status", { session: null })).status).toBe(409)
    expect((await call("GET", "/status", { session: "a".repeat(64) })).status).toBe(409)
    expect((await call("GET", "/status", { token: "not-a-valid-token" })).status).toBe(401)
    environment.team = true
    const member = createSessionToken("192.0.2.1", undefined, { userId: "member", username: "member", role: "member" })
    expect((await call("POST", "/session", { token: member, session: null })).status).toBe(403)
    const admin = createSessionToken("192.0.2.1", undefined, { userId: "admin", username: "admin", role: "admin" })
    const created = await call("POST", "/session", { token: admin, session: null })
    expect(created.status).toBe(200)
    expect((await call("GET", "/status", { token: admin, session: created.data.sessionId })).status).toBe(200)
    expect((await call("GET", "/status", { token: admin, session })).status).toBe(409)
  })

  it.each([["POST", "/status"], ["GET", "/leases"], ["PUT", "/session"], ["PATCH", "/stage"]])("rejects unsupported method %s on %s without mutating the store", async (method, path) => {
    const before = manager.snapshot()
    expect((await call(method, path)).status).toBe(405)
    expect(manager.snapshot()).toEqual(before)
  })

  it("bounds lease JSON, binary uploads and stage metadata headers", async () => {
    expect((await call("POST", "/leases", { body: { contextEpoch: "a".repeat(65_536) } })).status).toBe(413)
    const headers = { "x-cogpit-plugin-client": JSON.stringify(client), "x-cogpit-plugin-scope": '{"type":"all"}' }
    expect((await call("POST", "/stage", { body: Buffer.alloc(PACKAGE_LIMITS.upload + 1), headers })).status).toBe(413)
    expect((await stage(undefined, { headers: { "x-cogpit-plugin-client": "x".repeat(16_385) } })).status).toBe(400)
    expect((await stage(undefined, { headers: { "x-cogpit-plugin-scope": '{"type":"all","type":"projects","projectIds":[]}' } })).status).toBe(400)
    expect(manager.snapshot().plugins).toEqual([])
  })

  it("keeps provisional bytes and every transaction action private to the coordinating session", async () => {
    const preview = (await stage()).data as PluginInstallPreview
    const other = (await call("POST", "/session", { session: null })).data.sessionId
    for (const [method, path] of [
      ["GET", `/payload/${preview.transactionId}`], ["GET", `/transactions/${preview.transactionId}`],
      ["POST", `/transactions/${preview.transactionId}/trial`], ["POST", `/transactions/${preview.transactionId}/commit`],
      ["DELETE", `/transactions/${preview.transactionId}`],
    ]) {
      const response = await call(method!, path!, { session: other, body: { expectedRevision: preview.registryRevision } })
      expect(response.status).toBe(400)
      expect(response.data.code).toBe("NOT_FOUND")
    }
    expect((await lease()).status).toBe(409)
    expect((await call("POST", `/transactions/${preview.transactionId}/trial`)).data.code).toBe("PAYLOAD_REQUIRED")
    expect((await call("GET", `/payload/${preview.transactionId}`)).raw).toEqual(signedPackage(authority).payload)
    expect((await call("POST", `/transactions/${preview.transactionId}/trial`)).status).toBe(200)
    expect(manager.snapshot().plugins).toEqual([])
    expect((await call("POST", `/transactions/${preview.transactionId}/commit`, { body: { expectedRevision: preview.registryRevision } })).status).toBe(200)
    expect((await lease()).status).toBe(200)
  })

  it("invalidates existing activations before disable, permission scope changes and uninstall", async () => {
    await install()
    const first = await lease()
    expect(first.status).toBe(200)
    const binding = manager.authorization.resolve(first.req)
    const record = manager.leases.resolve(binding, first.data.id)
    expect((await call("POST", "/installed/dev-test.probe/enabled", { body: { expectedRevision: manager.snapshot().revision, enabled: false } })).status).toBe(200)
    expect(record.signal.aborted).toBe(true)
    expect((await call("POST", `/leases/${first.data.id}/renew`)).status).toBe(409)
    expect((await lease()).status).toBe(409)
    expect((await call("POST", "/installed/dev-test.probe/enabled", { body: { expectedRevision: manager.snapshot().revision, enabled: true } })).status).toBe(200)
    const second = await lease()
    expect((await call("POST", "/installed/dev-test.probe/scope", { body: { expectedRevision: manager.snapshot().revision, scope: { type: "projects", projectIds: [] } } })).status).toBe(200)
    expect((await call("POST", `/leases/${second.data.id}/renew`)).status).toBe(409)
    expect((await lease()).status).toBe(403)
    expect((await call("DELETE", "/installed/dev-test.probe", { body: { expectedRevision: manager.snapshot().revision } })).status).toBe(200)
    expect(manager.snapshot().plugins).toEqual([])
  })

  it("requires a saved-data revision for uninstall deletion and forbids choosing another principal", async () => {
    await install()
    const expectedRevision = manager.snapshot().revision
    for (const body of [
      { expectedRevision, deleteData: true },
      { expectedRevision, deleteData: false, expectedConnectionRevision: manager.connectionRevision },
      { expectedRevision, deleteData: true, expectedConnectionRevision: manager.connectionRevision, principalId: "other-admin" },
    ]) expect((await call("DELETE", "/installed/dev-test.probe", { body })).status).toBe(400)
    expect(manager.snapshot().plugins).toHaveLength(1)
    const result = await call("DELETE", "/installed/dev-test.probe", { body: { expectedRevision, deleteData: true, expectedConnectionRevision: manager.connectionRevision } })
    expect(result.status).toBe(200)
    expect(result.data).toMatchObject({ available: true, plugins: [] })
    expect(manager.store.pendingDataDeletions()).toEqual([])
  })

  it("binds project selection to a canonical inventory identity and rejects foreign paths", async () => {
    const project = join(directory, "project")
    await mkdir(project)
    environment.paths = [await realpath(project)]
    const status = await call("GET", "/status")
    const id = status.data.projects[0].id
    await install({ type: "projects", projectIds: [id] })
    expect((await lease(id)).status).toBe(200)
    expect((await lease(null)).status).toBe(403)
    expect((await lease(project)).status).toBe(400)
    expect((await stage({ type: "projects", projectIds: ["p_" + "f".repeat(40)] })).status).toBe(400)
  })

  it("rechecks authentication after project lookup and rejects stale completion", async () => {
    await install()
    const token = createSessionToken("192.0.2.1")
    const remoteSession = (await call("POST", "/session", { token, session: null })).data.sessionId
    vi.spyOn(manager.projects, "resolve").mockImplementation(async () => { await revokeSessionToken(token); return null })
    const result = await call("POST", "/leases", { token, session: remoteSession, body: { pluginId: "dev-test.probe", projectId: null, contextEpoch: "epoch-a", client } })
    expect(result.status).toBe(403)
    expect(result.data.code).toBe("PERMISSION_REQUIRED")
  })

  it("rejects a trial commit after its owner logs out", async () => {
    const token = createSessionToken("192.0.2.1")
    const remoteSession = (await call("POST", "/session", { token, session: null })).data.sessionId
    const preview = (await stage(undefined, { token, session: remoteSession })).data as PluginInstallPreview
    expect((await call("GET", `/payload/${preview.transactionId}`, { token, session: remoteSession })).status).toBe(200)
    expect((await call("POST", `/transactions/${preview.transactionId}/trial`, { token, session: remoteSession })).status).toBe(200)
    await revokeSessionToken(token)
    expect((await call("POST", `/transactions/${preview.transactionId}/commit`, { token, session: remoteSession, body: { expectedRevision: preview.registryRevision } })).status).toBe(401)
    expect(manager.snapshot().plugins).toEqual([])
  })

  it("rejects stale review revisions and trials that expire before commit", async () => {
    const preview = (await stage()).data as PluginInstallPreview
    expect((await call("GET", `/payload/${preview.transactionId}`)).status).toBe(200)
    const trial = await call("POST", `/transactions/${preview.transactionId}/trial`)
    expect(trial.status).toBe(200)
    const stale = await call("POST", `/transactions/${preview.transactionId}/commit`, { body: { expectedRevision: preview.registryRevision + 1 } })
    expect(stale.status).toBe(400)
    expect(stale.data.code).toBe("STALE_REVISION")
    vi.spyOn(Date, "now").mockReturnValue(trial.data.deadline + 1)
    const expired = await call("POST", `/transactions/${preview.transactionId}/commit`, { body: { expectedRevision: preview.registryRevision } })
    expect(expired.status).toBe(400)
    expect(expired.data.code).toBe("TRIAL_EXPIRED")
    expect(manager.snapshot().plugins).toEqual([])
  })

  it("requires a current activation for calls and rejects unsupported capabilities", async () => {
    await install()
    const created = await lease()
    const ready = { protocol: 1, type: "request", id: "one", method: "lifecycle.ready", params: {} }
    expect((await call("POST", `/leases/${created.data.id}/call`, { body: ready })).data).toEqual({ value: null })
    expect((await call("POST", `/leases/${created.data.id}/call`, { body: { ...ready, id: "append", method: "composer.append", params: { text: "hello" } } })).status).toBe(403)
    expect((await call("POST", `/leases/${created.data.id}/call`, { body: { protocol: 1, type: "result", id: "one", value: null } })).status).toBe(400)
    vi.stubEnv("COGPIT_DISABLE_PLUGINS", "1")
    expect((await call("POST", `/leases/${created.data.id}/call`, { body: ready })).status).toBe(409)
    expect((await lease()).status).toBe(409)
  })

  it("captures the original manager and cannot serve a replacement manager after disposal", async () => {
    await install()
    const originalHandler = handler
    const original = manager
    const replacement = await initializePluginManager(join(directory, "second-host"))
    opened.push(replacement)
    expect((await call("GET", "/status", { handler: originalHandler })).data.store.plugins).toHaveLength(1)
    const replacementHandler = captureRoutes()
    expect((await call("GET", "/status", { handler: replacementHandler })).status).toBe(409)
    await original.close()
    expect((await call("GET", "/status", { handler: originalHandler })).status).toBe(409)
    expect(replacement.snapshot().plugins).toEqual([])
  })
})
