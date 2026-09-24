// @vitest-environment node
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IncomingMessage } from "node:http"
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConnectionDefinition } from "@cogpit/plugin-contracts"
vi.mock("../../security", () => ({ onSessionRevoked: () => () => {}, isSessionTokenActive: () => true, getSessionPrincipal: () => null }))
vi.mock("../../routes/hello", () => ({ getInstanceId: () => "legacy-fixture", getAppVersion: () => "2.6.6" }))
vi.mock("../../agents", () => ({ allStores: () => [] }))
import { __resetEditionForTest } from "../../edition"
import * as security from "../../security"
import { setRequestAuthentication } from "../../requestAuthentication"
import { PluginManager } from "../../plugins/manager"
import type { ConnectionTransport } from "../../plugins/connectionExecutor"
import type { LegacyHostClassification } from "../../plugins/legacyHost"
import { registerClickUpRoutes } from "../../routes/clickup"
import type { Middleware } from "../../http"
import { useAccountSignIn } from "../edition/fakeEdition"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"
import { createAuthority, createRoot } from "./fixtures/signing"
import { authorize, client, signedPackage, type SignedPackage } from "./fixtures/storeSigning"

let directory: string, projectPath: string, unopenedPath: string, legacyPath: string
let manager: PluginManager, req: IncomingMessage, installed: SignedPackage
let transport: ReturnType<typeof vi.fn<ConnectionTransport>>
let authority: ReturnType<typeof createAuthority>
const projectId = `p_${"1".repeat(40)}`, unopenedId = `p_${"2".repeat(40)}`
const token = "pk_fixture_123456789_PRIVATE"
const classification: LegacyHostClassification = { formatVersion: 1, minWriterVersion: 1, classification: "legacy", capturedAt: 1, evidence: "config.local.json" }
const target = (project: string | null = null) => ({ pluginId: "cogpit.clickup", connectionId: "clickup", projectId: project })
const options = { authorize }
function session() {
  const request = asIncomingMessage({ headers: {}, socket: { remoteAddress: "127.0.0.1" } })
  setRequestAuthentication(request, { kind: "local" })
  request.headers["x-cogpit-plugin-session"] = manager.authorization.createOrRenewSession(request).sessionId
  return request
}
function projects() {
  const values = [{ id: projectId, name: "Project", paths: [projectPath] }, { id: unopenedId, name: "Unopened", paths: [unopenedPath] }]
  vi.spyOn(manager.projects, "list").mockResolvedValue(values)
  vi.spyOn(manager.projects, "resolveWorkspace").mockImplementation(async (id, path) => {
    const project = await manager.projects.resolve(id)
    if (path && !project?.paths.some(root => path === root || path.startsWith(root + "/"))) throw new Error("Unknown workspace")
    return path ?? null
  })
  vi.spyOn(manager.projects, "resolveContext").mockImplementation(async (id, path) => {
    const project = await manager.projects.resolve(id)
    if (path && !project?.paths.some(root => path === root || path.startsWith(root + "/"))) throw new Error("Unknown workspace")
    return { project, workspacePath: path ?? null }
  })
  vi.spyOn(manager.projects, "resolve").mockImplementation(async id => id === null ? null : values.find(value => value.id === id) ?? Promise.reject(new Error("Unknown project")))
}
function response(path: string): unknown {
  const url = new URL(path, "https://api.clickup.com")
  if (url.pathname === "/api/v2/user") return { user: { id: 7, username: "Fixture" } }
  if (url.pathname === "/api/v2/team") return { teams: [{ id: "10", name: "Workspace" }] }
  if (url.pathname === "/api/v2/team/10/space") return { spaces: [{ id: "20", name: "Space" }] }
  if (url.pathname === "/api/v2/space/20/list") return { lists: [{ id: "30", name: "List" }, { id: "31", name: "Other list" }] }
  if (url.pathname === "/api/v2/space/20/folder") return { folders: [{ id: "40", name: "Folder", lists: [{ id: "32", name: "Nested list" }] }] }
  if (/^\/api\/v2\/list\/3[01]$/.test(url.pathname)) return { id: url.pathname.endsWith("31") ? "31" : "30", name: "List", space: { id: "20" }, statuses: [] }
  if (url.pathname.endsWith("/task")) return { tasks: [], last_page: true }
  throw new Error("Fixture rejected unexpected path")
}
async function start(environment: Record<string, string> = {}) {
  manager = new PluginManager(join(directory, "runtime-plugins"), { officialRoots: new Map([["cogpit", createRoot(authority)]]), transport, environment })
  await manager.initialize(); projects(); req = session()
}
async function install(change?: "origin" | "header" | "scheme") {
  const declared = parseConnectionDefinition(JSON.parse(await readFile(join(process.cwd(), "plugins/clickup/connections/clickup.json"), "utf8")))
  if (change === "origin") for (const operation of Object.values(declared.operations)) operation.origin = "https://other.example.com"
  if (change === "header") declared.auth.header = "X-Provider-Key"
  if (change === "scheme") declared.auth.scheme = "bearer"
  installed = signedPackage(authority, { publisher: "cogpit", id: "cogpit.clickup", connection: declared, ...change ? { version: "1.1.0", metadataVersion: 2, retained: [installed] } : {} })
  const owner = manager.authorization.resolve(req).sessionId
  const preview = await manager.store.stage(installed.bytes, { owner, client, scope: { type: "all" }, authorize })
  await manager.store.payload(preview.transactionId, owner); await manager.store.beginTrial(preview.transactionId, owner, options)
  await manager.store.commit(preview.transactionId, owner, { expectedRevision: preview.registryRevision, authorize })
}
async function prepare() {
  await writeFile(legacyPath, JSON.stringify({ token, projects: { [projectPath]: "30", [unopenedPath]: "31" } }))
  await manager.prepareLegacyClickUp({ path: legacyPath, classification, authorize })
}
async function route(path: string, method = "GET", body?: unknown) {
  const handlers = new Map<string, Middleware>()
  registerClickUpRoutes((path, handler) => { handlers.set(path, handler) }, { manager: () => manager, now: () => Date.UTC(2026, 8, 14) })
  const [pathname, query] = path.split("?")
  const request = asIncomingMessage(Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { headers: {}, method, url: `/${query ? `?${query}` : ""}`, socket: { remoteAddress: "127.0.0.1", destroyed: false } }))
  setRequestAuthentication(request, { kind: "local" })
  let output = ""
  const response = asServerResponse({ statusCode: 200, setHeader: vi.fn(), end: (value?: string) => { output = value ?? "" } })
  await getRouteHandler(handlers, `/api/clickup/${pathname}`)(request, response, vi.fn())
  return { status: response.statusCode, body: output ? JSON.parse(output) : null }
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "cogpit-legacy-clickup-")))
  projectPath = join(directory, "project"); unopenedPath = join(directory, "unopened"); legacyPath = join(directory, "clickup.json")
  await mkdir(projectPath); await mkdir(unopenedPath)
  authority = createAuthority(); transport = vi.fn(async input => response(input.path))
  await start(); await install()
})
afterEach(async () => { await manager.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); __resetEditionForTest(); await rm(directory, { recursive: true, force: true }) })

describe("legacy ClickUp migration and one-way route adapters", () => {
  it("makes an exact backup and stores all pending projects without contacting a provider at startup", async () => {
    await prepare()
    expect(transport).not.toHaveBeenCalled()
    const backup = (await readdir(directory)).find(name => name.includes(".pre-runtime-"))!
    expect(await readFile(join(directory, backup))).toEqual(await readFile(legacyPath))
    await manager.prepareLegacyClickUp({ path: legacyPath, classification, authorize })
    expect((await readdir(directory)).filter(name => name.includes(".pre-runtime-"))).toHaveLength(1)
    const publicState = await manager.listConnections(req, target())
    expect(publicState.connections[0]).toMatchObject({ status: "connected", selected: { workspace: { id: "10" } }, legacyImportAvailable: true })
    expect(JSON.stringify(publicState)).not.toContain(token)
    expect(JSON.stringify(publicState)).not.toContain(directory)
    expect((await manager.listConnections(req, target(projectId))).connections[0].selected.list.id).toBe("30")
    await manager.close(); await start()
    expect((await manager.listConnections(req, target(unopenedId))).connections[0].selected.list.id).toBe("31")
  })
  it("keeps editable settings available after a failed automatic import and stops retrying", async () => {
    await prepare()
    transport.mockImplementation(async () => { throw new Error(`secret ${token} at ${directory}`) })
    const editable = await manager.listConnections(req, target(projectId))
    expect(editable.connections[0]).toMatchObject({ status: "disconnected", readOnly: false, legacyImportAvailable: true })
    expect(manager.snapshot()).toMatchObject({ available: true, error: expect.stringContaining("Legacy ClickUp settings could not be imported") })
    expect(JSON.stringify(manager.snapshot())).not.toContain(token)
    const document = JSON.parse(await readFile(join(directory, "runtime-plugin-connections", "connections.json"), "utf8"))
    expect(document.connections).toEqual({})
    expect(document.legacyClickUp).toMatchObject({ credentialImported: false, automatic: false, automaticFailed: true })
    expect(document.legacyClickUp.projects[unopenedPath]).toBe("31")
    await manager.close(); await start(); transport.mockClear()
    expect((await manager.listConnections(req, target(projectId))).connections[0].status).toBe("disconnected")
    expect(transport).not.toHaveBeenCalled()
    expect(manager.snapshot().error).toContain("Legacy ClickUp settings could not be imported")
    transport.mockImplementation(async input => response(input.path))
    const recovered = await manager.setCredential(req, { ...target(projectId), expectedRevision: manager.connectionRevision, secret: "pk_replacement_valid_credential" }, options)
    expect(recovered.connections[0]).toMatchObject({ status: "connected", readOnly: false })
  })
  it("requires an explicit import for a changed legacy file and never overwrites newer settings automatically", async () => {
    await prepare(); await manager.listConnections(req, target(projectId))
    await writeFile(legacyPath, JSON.stringify({ token: "pk_changed_123456789", projects: {} }))
    await manager.prepareLegacyClickUp({ path: legacyPath, classification, authorize })
    transport.mockClear()
    const current = await manager.listConnections(req, target(projectId))
    expect(current.connections[0].selected.list.id).toBe("30")
    expect(transport).not.toHaveBeenCalled()
    await expect(manager.importLegacyConnection(req, { ...target(projectId), expectedRevision: current.revision }, options)).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    await manager.importLegacyConnection(req, { ...target(projectId), expectedRevision: current.revision, replaceExisting: true }, options)
    expect(transport.mock.calls.some(([input]) => input.credential.secret === "pk_changed_123456789")).toBe(true)
  })
  it.each(["disabled", "safe-mode", "scope", "incompatible"])("does not import during a %s activation", async reason => {
    await prepare()
    const before = await readFile(join(directory, "runtime-plugin-connections", "connections.json"))
    if (reason === "disabled") await manager.store.setEnabled(installed.manifest.id, false, { authorize, expectedRevision: manager.snapshot().revision })
    if (reason === "scope") await manager.store.setScope(installed.manifest.id, { type: "projects", projectIds: [unopenedId] }, { authorize, expectedRevision: manager.snapshot().revision })
    if (reason === "safe-mode") vi.stubEnv("COGPIT_DISABLE_PLUGINS", "1")
    await expect(manager.createLease(req, { pluginId: installed.manifest.id, projectId, contextEpoch: "blocked", client: reason === "incompatible" ? { ...client, appVersion: "0.0.1" } : client })).rejects.toMatchObject({ code: reason === "scope" ? "PERMISSION_REQUIRED" : "STALE_ACTIVATION" })
    if (reason === "disabled" || reason === "safe-mode") expect((await manager.listConnections(req, target())).connections[0].status).toBe("disconnected")
    expect(transport).not.toHaveBeenCalled()
    expect(await readFile(join(directory, "runtime-plugin-connections", "connections.json"))).toEqual(before)
  })
  it.each(["origin", "header", "scheme"] as const)("does not inject a legacy token into a changed signed %s", async change => {
    await install(change); await prepare()
    const before = await readFile(join(directory, "runtime-plugin-connections", "connections.json"))
    expect((await manager.listConnections(req, target())).connections[0].status).toBe("disconnected")
    await expect(manager.importLegacyConnection(req, { ...target(), expectedRevision: manager.connectionRevision }, options)).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    expect(transport).not.toHaveBeenCalled()
    expect(await readFile(join(directory, "runtime-plugin-connections", "connections.json"))).toEqual(before)
  })
  it("leaves legacy credentials unclaimed where accounts sign in until one administrator explicitly imports them", async () => {
    useAccountSignIn()
    const principals = new Map(["admin-a", "admin-b"].map(userId => [userId, { userId, username: userId, role: "admin" as const }]))
    vi.spyOn(security, "getSessionPrincipal").mockImplementation(token => principals.get(token) ?? null)
    const admin = (id: string) => {
      const request = asIncomingMessage({ headers: {}, socket: { remoteAddress: "127.0.0.1" } })
      setRequestAuthentication(request, { kind: "session", token: id, principal: principals.get(id)! })
      request.headers["x-cogpit-plugin-session"] = manager.authorization.createOrRenewSession(request).sessionId
      return request
    }
    await prepare()
    const first = admin("admin-a"), second = admin("admin-b")
    const available = await manager.listConnections(first, target())
    expect(available.connections[0]).toMatchObject({ status: "disconnected", legacyImportAvailable: true })
    expect(transport).not.toHaveBeenCalled()
    await manager.importLegacyConnection(first, { ...target(), expectedRevision: available.revision }, options)
    expect((await manager.listConnections(second, target())).connections[0]).toMatchObject({ status: "disconnected", legacyImportAvailable: false })
    await expect(manager.importLegacyConnection(second, { ...target(), expectedRevision: manager.connectionRevision }, options)).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
  })
  it("keeps an explicit disconnect from resurrecting a pending legacy credential", async () => {
    await prepare()
    await manager.setCredential(req, { ...target(), secret: "pk_newer_123456789", expectedRevision: manager.connectionRevision }, options)
    await manager.disconnect(req, { ...target(), expectedRevision: manager.connectionRevision }, options)
    transport.mockClear()
    expect((await manager.listConnections(req, target(projectId))).connections[0]).toMatchObject({ status: "disconnected", legacyImportAvailable: false })
    expect(transport).not.toHaveBeenCalled()
  })
  it("validates the original pending token after a first-run environment override is removed", async () => {
    await manager.close(); await start({ COGPIT_CLICKUP_TOKEN: "pk_environment_first_run" })
    await prepare()
    expect(transport).not.toHaveBeenCalled()
    expect((await manager.listConnections(req, target(projectId))).connections[0]).toMatchObject({ status: "environment", selected: { list: { id: "30" } } })
    const document = JSON.parse(await readFile(join(directory, "runtime-plugin-connections", "connections.json"), "utf8"))
    expect(document.legacyClickUp).toMatchObject({ credentialImported: false, environmentPrepared: true })
    expect(Object.values(document.connections).every(value => !(value as { secret?: string }).secret)).toBe(true)
    await manager.close(); transport.mockClear(); await start()
    const imported = await manager.listConnections(req, target(projectId))
    expect(imported.connections[0]).toMatchObject({ status: "connected", readOnly: false, selected: { list: { id: "30" } } })
    expect(transport.mock.calls.some(([input]) => input.path === "/api/v2/user" && input.credential.secret === token)).toBe(true)
    expect(JSON.stringify(imported)).not.toContain(token)
  })
  it("revalidates and clears unavailable environment selections when falling back to another account", async () => {
    await manager.close(); await start({ COGPIT_CLICKUP_TOKEN: "pk_environment_first_run" })
    await prepare()
    expect((await manager.listConnections(req, target(projectId))).connections[0].selected).toMatchObject({ workspace: { id: "10" }, list: { id: "30" } })
    await manager.close(); transport.mockClear(); await start()
    transport.mockImplementation(async input => {
      expect(input.credential.secret).toBe(token)
      if (input.path === "/api/v2/team") return { teams: [{ id: "11", name: "Legacy account workspace" }] }
      return response(input.path)
    })
    const imported = await manager.listConnections(req, target(projectId))
    expect(imported.connections[0]).toMatchObject({ status: "connected", readOnly: false, selected: { workspace: { id: "11", label: "Legacy account workspace" } } })
    expect(imported.connections[0].selected.list).toBeUndefined()
    expect(imported.connections[0].selected.space).toBeUndefined()
    expect(transport.mock.calls.some(([input]) => input.path === "/api/v2/user")).toBe(true)
    transport.mockClear()
    expect((await manager.listConnections(req, target(projectId))).connections[0].selected.workspace.id).toBe("11")
    expect(transport).not.toHaveBeenCalled()
    expect(await readFile(legacyPath, "utf8")).toContain('"30"')
  })
  it("clears claimed pending data while retaining the original file and recovery backup", async () => {
    await prepare(); await manager.listConnections(req, target(projectId))
    await manager.clearData(req, { pluginId: installed.manifest.id, expectedRevision: manager.connectionRevision }, options)
    const retained = await readFile(join(directory, "runtime-plugin-connections", "connections.json"), "utf8")
    expect(retained).not.toContain(token)
    expect(JSON.parse(retained).legacyClickUp).toMatchObject({ suppressed: true, projects: {} })
    expect(await readFile(legacyPath, "utf8")).toContain(token)
    expect((await readdir(directory)).some(name => name.includes(".pre-runtime-"))).toBe(true)
  })
  it("shares the provider rate budget across disposable legacy sessions", async () => {
    await manager.setCredential(req, { ...target(), secret: token, expectedRevision: manager.connectionRevision }, options)
    const create = vi.spyOn(manager.authorization, "createOrRenewSession"), dispose = vi.spyOn(manager.authorization, "revokeSession")
    for (let i = 0; i < 120; i++) await manager.withLegacyPlugin(req, { pluginId: installed.manifest.id }, caller => caller.call("viewer", {}))
    await expect(manager.withLegacyPlugin(req, { pluginId: installed.manifest.id }, caller => caller.call("viewer", {}))).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(create).toHaveBeenCalledTimes(121)
    expect(dispose).toHaveBeenCalledTimes(121)
  })
  it("reports nonfatal migration warnings while preserving explicit plugin management", async () => {
    manager.reportMigrationIssue("Legacy configuration requires inspection")
    expect(manager.snapshot()).toMatchObject({ available: true, error: "Legacy configuration requires inspection" })
    await manager.store.setEnabled(installed.manifest.id, false, { authorize, expectedRevision: manager.snapshot().revision })
    expect(manager.snapshot().plugins[0].enabled).toBe(false)
  })
  it("keeps explicit project unlink decisions across pending aliases and restart", async () => {
    const alias = join(projectPath, "subdirectory")
    await mkdir(alias)
    await writeFile(legacyPath, JSON.stringify({ token, projects: { [projectPath]: "30", [alias]: "31", [unopenedPath]: "31" } }))
    await manager.prepareLegacyClickUp({ path: legacyPath, classification, authorize })
    await manager.listConnections(req, target())
    await manager.selectResource(req, { ...target(projectId), resourceId: "list", value: null, expectedRevision: manager.connectionRevision }, options)
    expect((await manager.listConnections(req, target(projectId))).connections[0].selected.list).toBeUndefined()
    await manager.close(); await start()
    transport.mockClear()
    expect((await manager.listConnections(req, target(projectId))).connections[0].selected.list).toBeUndefined()
    expect(transport).not.toHaveBeenCalled()
    expect((await manager.listConnections(req, target(unopenedId))).connections[0].selected.list.id).toBe("31")
  })
  it("resolves nested projects to the longest canonical root for grants and imports", async () => {
    const childPath = join(projectPath, "nested"), childId = `p_${"3".repeat(40)}`
    await mkdir(childPath)
    const inventory = [{ id: projectId, name: "Parent", paths: [projectPath] }, { id: childId, name: "Child", paths: [childPath] }]
    vi.mocked(manager.projects.list).mockResolvedValue(inventory)
    vi.mocked(manager.projects.resolve).mockImplementation(async id => id === null ? null : inventory.find(project => project.id === id) ?? Promise.reject(new Error("Unknown")))
    await writeFile(legacyPath, JSON.stringify({ token, projects: { [childPath]: "31" } }))
    await manager.prepareLegacyClickUp({ path: legacyPath, classification, authorize })
    const parent = await manager.listConnections(req, target(projectId))
    expect(parent.connections[0].selected.list).toBeUndefined()
    await manager.store.setScope(installed.manifest.id, { type: "projects", projectIds: [projectId] }, { authorize, expectedRevision: manager.snapshot().revision })
    transport.mockClear()
    expect((await route(`tasks/list?cwd=${encodeURIComponent(childPath)}`)).status).toBe(409)
    expect(transport).not.toHaveBeenCalled()
    expect((await manager.listConnections(req, target(childId))).connections[0].selected.list.id).toBe("31")
  })
  it("keeps old task, setup, and project-link envelopes on the generic broker", async () => {
    await prepare()
    const status = await route("status")
    expect(status.body).toMatchObject({ configured: true, tokenFromEnv: false, viewer: { id: 7 }, workspace: { id: "10" } })
    expect((await route("tasks/mine")).body).toMatchObject({ tasks: [], truncated: false })
    expect((await route(`tasks/list?cwd=${encodeURIComponent(projectPath)}`)).body).toMatchObject({ list: { id: "30" }, tasks: [] })
    expect((await route("spaces")).body.spaces).toEqual([{ id: "20", name: "Space" }])
    expect((await route("lists?spaceId=20")).body.lists).toEqual([{ id: "30", name: "List", folderName: null }, { id: "31", name: "Other list", folderName: null }, { id: "32", name: "Nested list", folderName: "Folder" }])
    expect((await route("project-list", "PUT", { cwd: projectPath, listId: "31" })).body).toEqual({ cwd: projectPath, listId: "31" })
    expect((await route(`project-list?cwd=${encodeURIComponent(projectPath)}`)).body.listId).toBe("31")
    expect((await route("project-list", "PUT", { cwd: projectPath, listId: null })).body.listId).toBeNull()
    expect((await route("token", "DELETE")).body.configured).toBe(false)
    expect(await readFile(legacyPath, "utf8")).toContain(token)
  })
  it.each(["disable", "uninstall", "scope"])("denies old clients immediately after %s", async action => {
    await prepare(); await route("status"); transport.mockClear()
    const mutation = { authorize, expectedRevision: manager.snapshot().revision }
    if (action === "disable") await manager.store.setEnabled(installed.manifest.id, false, mutation)
    if (action === "uninstall") await manager.store.uninstall(installed.manifest.id, mutation)
    if (action === "scope") await manager.store.setScope(installed.manifest.id, { type: "projects", projectIds: [unopenedId] }, mutation)
    expect((await route(`tasks/list?cwd=${encodeURIComponent(projectPath)}`)).status).toBe(409)
    expect((await route("token", "POST", { token })).status).toBe(409)
    expect(transport).not.toHaveBeenCalled()
  })
  it("rejects a legacy provider response after the installation is disabled", async () => {
    await prepare(); await route("status")
    let release!: (value: unknown) => void, start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    transport.mockImplementationOnce(() => new Promise(resolve => { start(); release = resolve }))
    const pending = route("tasks/mine")
    await started
    await manager.store.setEnabled(installed.manifest.id, false, { authorize, expectedRevision: manager.snapshot().revision })
    release({ user: { id: 7, username: "Fixture" } })
    expect((await pending).status).toBe(409)
  })
})
