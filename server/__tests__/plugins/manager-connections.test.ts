// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IncomingMessage } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConnectionDefinition, parseFrameMessage, type PluginRequest } from "@cogpit/plugin-contracts"
vi.mock("../../team/edition", () => ({ isTeamEdition: () => false }))
vi.mock("../../security", () => ({ onSessionRevoked: () => () => {}, isSessionTokenActive: () => true, getSessionPrincipal: (token: string) => token.startsWith("admin-") ? { userId: token, username: token, role: "admin" } : null }))
vi.mock("../../routes/hello", () => ({ getInstanceId: () => "fixture-host", getAppVersion: () => "2.6.6" }))
vi.mock("../../agents", () => ({ allStores: () => [] }))
import { setRequestAuthentication } from "../../requestAuthentication"
import { PluginManager } from "../../plugins/manager"
import { PluginConnectionStore } from "../../plugins/connectionStore"
import { PluginStateStore } from "../../plugins/stateStore"
import { PluginDataError } from "../../plugins/privateStore"
import type { ConnectionTransport } from "../../plugins/connectionExecutor"
import { createAuthority, createRoot } from "./fixtures/signing"
import { authorize, client, signedPackage, type SignedPackage } from "./fixtures/storeSigning"

let directory: string
let manager: PluginManager
let req: IncomingMessage
let transport: ReturnType<typeof vi.fn<ConnectionTransport>>
let authority: ReturnType<typeof createAuthority>
let installed: SignedPackage
const project1 = `p_${"1".repeat(40)}`, project2 = `p_${"2".repeat(40)}`
const token = "fixture-credential-never-public"
const target = (projectId: string | null = project1) => ({ pluginId: "dev-test.probe", projectId })
const connectionTarget = (projectId: string | null = project1) => ({ ...target(projectId), connectionId: "catalog" })
const mutation = (projectId: string | null = project1) => ({ ...connectionTarget(projectId), expectedRevision: manager.connectionRevision })
const options = { authorize }
function definition(id = "catalog", origin = "https://api.example.com") {
  const operation = (audience: "setup" | "panel", path: ({ literal: string } | { resource: string })[]) => ({ audience, origin, method: "GET", path, args: {}, query: {} })
  return parseConnectionDefinition({ version: 1, id, label: "Catalog", secret: { id: "token", label: "Token" }, auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate", identity: { user: "/id" }, resources: {
    account: { label: "Account", scope: "connection", options: { operation: "accounts", items: "/items", id: "/id", label: "/name" } },
    item: { label: "Item", scope: "project", dependsOn: ["account"], options: { operation: "items", items: "/items", id: "/id", label: "/name" } },
  }, operations: { validate: operation("setup", [{ literal: "validate" }]), accounts: operation("setup", [{ literal: "accounts" }]), items: operation("setup", [{ literal: "accounts" }, { resource: "account" }, { literal: "items" }]), read: operation("panel", [{ literal: "accounts" }, { resource: "account" }, { literal: "items" }, { resource: "item" }, { literal: "data" }]) } })
}
function response(path: string) {
  if (path === "/validate") return { id: "user-one" }
  if (path === "/accounts") return { items: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }] }
  if (path.endsWith("/items")) return { items: [{ id: "x", name: "Item X" }, { id: "y", name: "Item Y" }] }
  return { success: true }
}
function request(method: PluginRequest["method"], params: object): PluginRequest { return parseFrameMessage({ protocol: 1, type: "request", id: "r1", method, params }) as PluginRequest }
function session(principalId?: string) {
  const value = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage
  setRequestAuthentication(value, principalId ? { kind: "session", token: principalId, principal: { userId: principalId, username: principalId, role: "admin" } } : { kind: "local" })
  value.headers["x-cogpit-plugin-session"] = manager.authorization.createOrRenewSession(value).sessionId
  return value
}
function projects() { vi.spyOn(manager.projects, "resolve").mockImplementation(async id => id ? { id, name: "Fixture", paths: [directory] } : null) }
async function install(candidate: SignedPackage) {
  const owner = manager.authorization.resolve(req).sessionId
  const preview = await manager.store.stage(candidate.bytes, { owner, client, scope: { type: "all" }, authorize })
  await manager.store.payload(preview.transactionId, owner); await manager.store.beginTrial(preview.transactionId, owner, options)
  await manager.store.commit(preview.transactionId, owner, { expectedRevision: preview.registryRevision, authorize })
}
async function configure(projectId = project1) {
  await manager.setCredential(req, { ...mutation(projectId), secret: token }, options)
  await manager.selectResource(req, { ...mutation(projectId), resourceId: "account", value: "a" }, options)
  await manager.selectResource(req, { ...mutation(projectId), resourceId: "item", value: "x" }, options)
}
async function lease(projectId: string | null = project1) { return manager.createLease(req, { ...target(projectId), client, contextEpoch: "epoch-1" }) }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cogpit-manager-connections-"))
  transport = vi.fn(async input => response(input.path))
  manager = new PluginManager(join(directory, "runtime-plugins"), { transport, environment: {} })
  await manager.initialize(); projects(); req = session()
  authority = createAuthority()
  await manager.store.enrollDeveloper("dev-test", "Fixture", createRoot(authority), options)
  installed = signedPackage(authority, { connection: definition(), composer: true, navigation: true, storage: { scope: "project", quotaKiB: 1 } })
  await install(installed)
})
afterEach(async () => { await manager.close(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })

describe("host-owned plugin connections and state", () => {
  it("preserves two clients' acknowledged writes through failed trials, update and rollback", async () => {
    const secondClient = session()
    const activation = await lease()
    let second = await manager.createLease(secondClient, { ...target(), client, contextEpoch: "second-client" })
    const unopened = await manager.createLease(secondClient, { ...target(project2), client, contextEpoch: "unopened-project" })
    await manager.call(secondClient, unopened.id, request("storage.set", { key: "unopened", value: "retained" }))
    const owner = manager.authorization.resolve(req).sessionId
    const candidate = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [installed], connection: definition(), storage: { scope: "project", quotaKiB: 1 } })
    const prepare = async () => {
      const preview = await manager.store.stage(candidate.bytes, { owner, client, scope: { type: "all" }, authorize })
      await manager.store.payload(preview.transactionId, owner); await manager.store.beginTrial(preview.transactionId, owner, options)
      return preview
    }
    const failed = await prepare()
    await manager.call(secondClient, second.id, request("storage.set", { key: "setting", value: "during failed trial" }))
    await manager.store.cancel(failed.transactionId, owner, options)
    expect(manager.snapshot().plugins[0].selectedDigest).toBe(installed.digest)
    expect(await manager.call(req, activation.id, request("storage.get", { key: "setting" }))).toBe("during failed trial")
    const update = await prepare()
    await manager.call(secondClient, second.id, request("storage.set", { key: "setting", value: "before update commit" }))
    await manager.store.commit(update.transactionId, owner, { expectedRevision: update.registryRevision, authorize })
    expect(activation.signal.aborted).toBe(true); expect(second.signal.aborted).toBe(true)
    await expect(manager.call(secondClient, second.id, request("storage.set", { key: "setting", value: "stale overwrite" }))).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    second = await manager.createLease(secondClient, { ...target(), client, contextEpoch: "updated" })
    expect(await manager.call(secondClient, second.id, request("storage.get", { key: "setting" }))).toBe("before update commit")
    await manager.call(secondClient, second.id, request("storage.set", { key: "setting", value: "after update" }))
    const rollback = await manager.store.rollback(installed.manifest.id, installed.digest, { owner, client, scope: { type: "all" }, authorize })
    await manager.store.payload(rollback.transactionId, owner); await manager.store.beginTrial(rollback.transactionId, owner, options)
    await manager.call(secondClient, second.id, request("storage.set", { key: "setting", value: "during rollback trial" }))
    await manager.store.commit(rollback.transactionId, owner, { expectedRevision: rollback.registryRevision, authorize })
    expect(second.signal.aborted).toBe(true)
    expect(await manager.call(req, (await lease()).id, request("storage.get", { key: "setting" }))).toBe("during rollback trial")
    expect(await manager.call(req, (await lease(project2)).id, request("storage.get", { key: "unopened" }))).toBe("retained")
  })

  it.each([false, true])("uninstall deleteData=%s affects only the current principal and retains schema guards", async deleteData => {
    await configure()
    for (const projectId of [project1, project2]) await manager.call(req, (await lease(projectId)).id, request("storage.set", { key: "setting", value: "owner value" }))
    const ownerRequest = req
    req = session("admin-other")
    await configure(project2)
    for (const projectId of [project1, project2]) await manager.call(req, (await lease(projectId)).id, request("storage.set", { key: "setting", value: "other principal" }))
    const otherRequest = req; req = ownerRequest
    const trust = await readFile(join(directory, "runtime-plugins", "trust.json"))
    const activation = await lease()
    await manager.uninstall(req, { pluginId: installed.manifest.id, expectedRevision: manager.snapshot().revision, ...(deleteData ? { deleteData: true, expectedConnectionRevision: manager.connectionRevision } : { deleteData: false }) }, options)
    expect(activation.signal.aborted).toBe(true)
    expect(manager.snapshot()).toMatchObject({ available: true, plugins: [] })
    expect(manager.store.pendingDataDeletions()).toEqual([])
    expect(await readFile(join(directory, "runtime-plugins", "trust.json"))).toEqual(trust)
    const incompatible = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, stateVersion: 2, retained: [installed] })
    await expect(install(incompatible)).rejects.toMatchObject({ code: "STATE_VERSION" })
    await install(signedPackage(authority, { metadataVersion: 3, connection: definition(), composer: true, navigation: true, storage: { scope: "project", quotaKiB: 1 } }))
    expect((await manager.listConnections(req, target())).connections[0].status).toBe(deleteData ? "disconnected" : "connected")
    for (const projectId of [project1, project2]) expect(await manager.call(req, (await lease(projectId)).id, request("storage.get", { key: "setting" }))).toBe(deleteData ? null : "owner value")
    req = otherRequest
    expect((await manager.listConnections(req, target(project2))).connections[0].status).toBe("connected")
    for (const projectId of [project1, project2]) expect(await manager.call(req, (await lease(projectId)).id, request("storage.get", { key: "setting" }))).toBe("other principal")
  })

  it("checks the saved-data revision and final authorization before deciding uninstall", async () => {
    const revision = manager.connectionRevision
    await configure()
    await expect(manager.uninstall(req, { pluginId: installed.manifest.id, expectedRevision: manager.snapshot().revision, deleteData: true, expectedConnectionRevision: revision }, options)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    const drain = vi.spyOn(PluginStateStore.prototype, "drain").mockImplementationOnce(async () => { manager.authorization.revokeSession(req) })
    await expect(manager.uninstall(req, { pluginId: installed.manifest.id, expectedRevision: manager.snapshot().revision, deleteData: true, expectedConnectionRevision: manager.connectionRevision }, options)).rejects.toMatchObject({ code: "FORBIDDEN" })
    drain.mockRestore(); req = session()
    expect(manager.snapshot().plugins[0].enabled).toBe(true)
    expect(manager.store.pendingDataDeletions()).toEqual([])
    expect((await manager.listConnections(req, target())).connections[0].status).toBe("connected")
  })

  it("serializes overlapping uninstall cleanup so a reinstall cannot be cleared by stale work", async () => {
    const other = signedPackage(authority, { id: "dev-test.other", metadataVersion: 2, retained: [installed] })
    await install(other)
    let firstStarted!: () => void, releaseFirst!: () => void, secondStarted!: () => void, releaseSecond!: () => void
    const firstReached = new Promise<void>(resolve => { firstStarted = resolve }), firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondReached = new Promise<void>(resolve => { secondStarted = resolve }), secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    const originalClear = PluginStateStore.prototype.clear
    vi.spyOn(PluginStateStore.prototype, "clear").mockImplementation(async function (this: PluginStateStore, scope) {
      if (scope.pluginId === installed.manifest.id) { firstStarted(); await firstGate }
      return originalClear.call(this, scope)
    })
    const originalBegin = PluginConnectionStore.prototype.beginClear
    const clears = vi.spyOn(PluginConnectionStore.prototype, "beginClear").mockImplementation(async function (this: PluginConnectionStore, scope, revision, guard) {
      if (scope.pluginId === other.manifest.id) { secondStarted(); await secondGate }
      return originalBegin.call(this, scope, revision, guard)
    })
    const first = manager.uninstall(req, { pluginId: installed.manifest.id, expectedRevision: manager.snapshot().revision, deleteData: true, expectedConnectionRevision: manager.connectionRevision }, options)
    await firstReached
    let secondCommitted!: () => void
    const secondDecision = new Promise<void>(resolve => { secondCommitted = resolve })
    const originalUninstall = manager.store.uninstall.bind(manager.store)
    vi.spyOn(manager.store, "uninstall").mockImplementation(async (...args) => { const value = await originalUninstall(...args); secondCommitted(); return value })
    const second = manager.uninstall(req, { pluginId: other.manifest.id, expectedRevision: manager.snapshot().revision, deleteData: true, expectedConnectionRevision: manager.connectionRevision }, options)
    await secondDecision; releaseFirst(); await secondReached
    expect(manager.store.pendingDataDeletions().map(value => value.pluginId)).toEqual([other.manifest.id])
    await install(signedPackage(authority, { metadataVersion: 3, retained: [other], connection: definition(), composer: true, navigation: true, storage: { scope: "project", quotaKiB: 1 } }))
    const activation = await lease()
    await manager.call(req, activation.id, request("storage.set", { key: "newSetting", value: "after reinstall" }))
    releaseSecond(); await Promise.all([first, second])
    expect(clears.mock.calls.filter(([scope]) => scope.pluginId === installed.manifest.id)).toHaveLength(1)
    expect(await manager.call(req, (await lease()).id, request("storage.get", { key: "newSetting" }))).toBe("after reinstall")
  })

  it.each([
    ["uninstall-registry:file-synced", 1, false],
    ["uninstall-registry:renamed", 1, true],
    ["private:renamed", 1, true],
    ["private:renamed", 2, true],
    ["private:renamed", 3, true],
    ["finish-data-deletion:renamed", 1, true],
  ] as const)("recovers uninstall at %s occurrence %s without losing other-principal data", async (step, occurrence, committed) => {
    await configure()
    await manager.call(req, (await lease(project2)).id, request("storage.set", { key: "setting", value: "owner value" }))
    req = session("admin-other")
    await configure(project2)
    await manager.call(req, (await lease(project2)).id, request("storage.set", { key: "setting", value: "other value" }))
    await manager.close()
    let armed = false, count = 0
    manager = new PluginManager(join(directory, "runtime-plugins"), { transport, environment: {}, crashHook: current => { if (armed && current === step && ++count === occurrence) throw new Error("simulated stop") } })
    await manager.initialize(); projects(); req = session(); armed = true
    await expect(manager.uninstall(req, { pluginId: installed.manifest.id, expectedRevision: manager.snapshot().revision, deleteData: true, expectedConnectionRevision: manager.connectionRevision }, options)).rejects.toThrow()
    expect(count).toBe(occurrence)
    await manager.close()
    manager = new PluginManager(join(directory, "runtime-plugins"), { transport, environment: {} }); await manager.initialize(); projects(); req = session()
    expect(manager.snapshot().available).toBe(true)
    expect(manager.store.pendingDataDeletions()).toEqual([])
    expect(manager.snapshot().plugins).toHaveLength(committed ? 0 : 1)
    if (committed) await install(installed)
    expect((await manager.listConnections(req, target(project2))).connections[0].status).toBe(committed ? "disconnected" : "connected")
    expect(await manager.call(req, (await lease(project2)).id, request("storage.get", { key: "setting" }))).toBe(committed ? null : "owner value")
    req = session("admin-other")
    expect((await manager.listConnections(req, target(project2))).connections[0].status).toBe("connected")
    expect(await manager.call(req, (await lease(project2)).id, request("storage.get", { key: "setting" }))).toBe("other value")
  })

  it("lists disconnected status and permits host setup while the plugin is disabled", async () => {
    expect((await manager.listConnections(req, target())).connections[0]).toMatchObject({ status: "disconnected", selected: {} })
    await manager.store.setEnabled(installed.manifest.id, false, { authorize, expectedRevision: manager.snapshot().revision })
    const configured = await manager.setCredential(req, { ...mutation(), secret: token }, options)
    expect(configured.connections[0].status).toBe("connected")
    expect(JSON.stringify(configured)).not.toContain(token)
    expect(JSON.stringify(configured)).not.toContain(directory)
    await expect(lease()).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
  })
  it("binds panel requests to selected resources and exposes status without credentials", async () => {
    await configure()
    const activation = await lease()
    expect(await manager.call(req, activation.id, request("connections.status", { handle: "catalog" }))).toEqual({ configured: true, readOnly: false, selected: { account: { id: "a", label: "Alpha" }, item: { id: "x", label: "Item X" } } })
    expect(await manager.call(req, activation.id, request("connections.request", { handle: "catalog", operationId: "read", args: {} }))).toEqual({ success: true })
    expect(transport.mock.calls.at(-1)?.[0].path).toBe("/accounts/a/items/x/data")
    await expect(manager.call(req, activation.id, request("connections.request", { handle: "another", operationId: "read", args: {} }))).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    await expect(manager.call(req, activation.id, request("connections.request", { handle: "catalog", operationId: "accounts", args: {} }))).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await expect(manager.call(req, activation.id, request("connections.request", { handle: "catalog", operationId: "read", args: { account: "b" } }))).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect((await manager.listConnections(req, target(project2))).connections[0].selected).toEqual({ account: { id: "a", label: "Alpha" } })
  })
  it("validates membership, clears dependent project selections, and revokes old leases", async () => {
    await configure()
    await manager.selectResource(req, { ...mutation(project2), resourceId: "item", value: "y" }, options)
    await manager.selectResource(req, { ...mutation(), resourceId: "account", value: "a" }, options)
    expect((await manager.listConnections(req, target(project2))).connections[0].selected.item.id).toBe("y")
    const revision = manager.connectionRevision
    await expect(manager.selectResource(req, { ...mutation(), resourceId: "account", value: "not-listed" }, options)).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(manager.connectionRevision).toBe(revision)
    const old = await lease()
    await manager.selectResource(req, { ...mutation(), resourceId: "account", value: "b" }, options)
    expect(old.signal.aborted).toBe(true)
    expect((await manager.listConnections(req, target(project2))).connections[0].selected).toEqual({ account: { id: "b", label: "Beta" } })
    await manager.selectResource(req, { ...mutation(), resourceId: "account", value: null }, options)
    expect((await manager.listConnections(req, target())).connections[0].selected).toEqual({})
  })
  it("aborts an in-flight provider call before changing credentials", async () => {
    await configure()
    const activation = await lease()
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    transport.mockImplementationOnce(input => new Promise((_resolve, reject) => { started(); input.signal.addEventListener("abort", () => reject(Object.assign(new Error("private upstream detail"), { code: "CANCELED" })), { once: true }) }))
    const pending = manager.call(req, activation.id, request("connections.request", { handle: "catalog", operationId: "read", args: {} }))
    const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELED", message: "Connection operation failed" })
    await waiting
    await manager.disconnect(req, mutation(), options)
    await rejected
    expect(activation.signal.aborted).toBe(true)
  })

  it("bounds concurrent provider work per activation and cancels all requests", async () => {
    await configure()
    const activation = await lease()
    const abort = new AbortController()
    let started!: () => void
    let count = 0
    const ready = new Promise<void>(resolve => { started = resolve })
    transport.mockImplementation(input => new Promise((_resolve, reject) => {
      if (++count === 8) started()
      input.signal.addEventListener("abort", () => reject(Object.assign(new Error("private detail"), { code: "CANCELED" })), { once: true })
    }))
    const pending = Array.from({ length: 8 }, () => manager.call(req, activation.id, request("connections.request", { handle: "catalog", operationId: "read", args: {} }), { signal: abort.signal }).catch(error => error.code))
    await ready
    await expect(manager.call(req, activation.id, request("connections.request", { handle: "catalog", operationId: "read", args: {} }))).rejects.toMatchObject({ code: "RATE_LIMITED" })
    abort.abort()
    expect(await Promise.all(pending)).toEqual(Array(8).fill("CANCELED"))
  })
  it("rejects credential validation that outlives the selected package digest", async () => {
    let release!: (value: unknown) => void
    let start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    transport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; start() }))
    const pending = manager.setCredential(req, { ...mutation(), secret: token }, options)
    const rejected = expect(pending).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    await started
    await install(signedPackage(authority, { connection: definition(), version: "1.1.0", metadataVersion: 2, retained: [installed] }))
    release({ id: "user-one" }); await rejected
    expect((await manager.listConnections(req, target())).connections[0].status).toBe("disconnected")
  })
  it("rejects options returned after the selected project disappears", async () => {
    await manager.setCredential(req, { ...mutation(), secret: token }, options)
    let release!: (value: unknown) => void, start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    transport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; start() }))
    const pending = manager.listResourceOptions(req, { ...connectionTarget(), resourceId: "account" }, options)
    const rejected = expect(pending).rejects.toMatchObject({ code: "STALE_ACTIVATION", message: "The selected project is unavailable" })
    await started
    vi.mocked(manager.projects.resolve).mockRejectedValue(new Error(`private host path ${directory}`))
    release(response("/accounts")); await rejected
  })
  it("uses signed composer permission and preserves project KV across disable and rollback", async () => {
    let activation = await lease()
    expect(await manager.call(req, activation.id, request("composer.append", { text: "Reviewable draft" }))).toBeNull()
    expect(await manager.call(req, activation.id, request("navigation.openExternal", { url: "https://example.com/item" }))).toBeNull()
    await manager.call(req, activation.id, request("storage.set", { key: "setting", value: { value: 7 } }))
    expect(await manager.call(req, activation.id, request("storage.get", { key: "setting" }))).toEqual({ value: 7 })
    const other = await lease(project2)
    expect(await manager.call(req, other.id, request("storage.get", { key: "setting" }))).toBeNull()
    await manager.store.setEnabled(installed.manifest.id, false, { authorize, expectedRevision: manager.snapshot().revision })
    await expect(manager.call(req, activation.id, request("storage.set", { key: "setting", value: 8 }))).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    await manager.store.setEnabled(installed.manifest.id, true, { authorize, expectedRevision: manager.snapshot().revision })
    activation = await lease()
    expect(await manager.call(req, activation.id, request("storage.get", { key: "setting" }))).toEqual({ value: 7 })
    await expect(manager.call(req, activation.id, request("storage.set", { key: "large", value: "x".repeat(1024) }))).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })
  it.each([true, false])("blocks activations while old state writes drain and clears the barrier after allowed=%s", async permitted => {
    const activation = await lease()
    let release!: () => void, start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const draining = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(PluginStateStore.prototype, "drain").mockImplementationOnce(() => { start(); return draining })
    let allowed = true
    const pending = manager.store.setEnabled(installed.manifest.id, true, { expectedRevision: manager.snapshot().revision, authorize: () => { if (!allowed) throw new PluginDataError("STALE_ACTIVATION", "Session changed") } })
    const outcome = pending.then(() => "committed", error => error.code)
    await started
    expect(activation.signal.aborted).toBe(true)
    await expect(lease()).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    allowed = permitted; release()
    expect(await outcome).toBe(permitted ? "committed" : "FORBIDDEN")
    expect((await lease()).signal.aborted).toBe(false)
  })
  it("explicitly clears saved connection and KV data while retaining publisher trust", async () => {
    await configure()
    const activation = await lease()
    await manager.call(req, activation.id, request("storage.set", { key: "setting", value: true }))
    const before = await readFile(join(directory, "runtime-plugins", "trust.json"))
    await manager.clearData(req, { pluginId: installed.manifest.id, expectedRevision: manager.connectionRevision }, options)
    expect(activation.signal.aborted).toBe(true)
    expect((await manager.listConnections(req, target())).connections[0].status).toBe("disconnected")
    const next = await lease()
    expect(await manager.call(req, next.id, request("storage.get", { key: "setting" }))).toBeNull()
    expect(await readFile(join(directory, "runtime-plugins", "trust.json"))).toEqual(before)
  })

  it.each(["origin", "header", "scope"])("does not reuse a credential after signed definition %s changes; compatible rollback restores it", async change => {
    await configure()
    const changed = definition()
    if (change === "origin") for (const operation of Object.values(changed.operations)) operation.origin = "https://other.example.com"
    if (change === "header") changed.auth.header = "X-Provider-Token"
    if (change === "scope") changed.resources.account.scope = "project"
    await install(signedPackage(authority, { connection: changed, version: "1.1.0", metadataVersion: 2, retained: [installed] }))
    const activation = await lease()
    expect(await manager.call(req, activation.id, request("connections.status", { handle: "catalog" }))).toEqual({ configured: false, readOnly: false, selected: {} })
    transport.mockClear()
    await expect(manager.call(req, activation.id, request("connections.request", { handle: "catalog", operationId: "read", args: {} }))).rejects.toMatchObject({ code: "CONNECTION_REQUIRED" })
    expect(transport).not.toHaveBeenCalled()
    await expect(manager.call(req, activation.id, request("composer.append", { text: "Unpermitted" }))).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    await expect(manager.call(req, activation.id, request("navigation.openExternal", { url: "https://example.com/item" }))).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    const owner = manager.authorization.resolve(req).sessionId
    const rollback = await manager.store.rollback(installed.manifest.id, installed.digest, { owner, client, scope: { type: "all" }, authorize })
    await manager.store.payload(rollback.transactionId, owner); await manager.store.beginTrial(rollback.transactionId, owner, options)
    await manager.store.commit(rollback.transactionId, owner, { expectedRevision: rollback.registryRevision, authorize })
    expect((await manager.listConnections(req, target())).connections[0]).toMatchObject({ status: "connected", selected: { account: { id: "a" }, item: { id: "x" } } })
  })

  it.each(["request", "logout"])("cancels credential validation on %s revocation without retaining the token", async action => {
    let start!: () => void, release!: (value: unknown) => void
    const started = new Promise<void>(resolve => { start = resolve })
    const abort = new AbortController()
    transport.mockImplementationOnce(() => new Promise(resolve => { start(); release = resolve }))
    const pending = manager.setCredential(req, { ...mutation(), secret: token }, { ...options, signal: abort.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELED", message: "Connection operation failed" })
    await started
    if (action === "request") abort.abort(); else manager.authorization.revokeSession(req)
    release({ id: "user-one" }); await rejected
    req = session()
    expect((await manager.listConnections(req, target())).connections[0].status).toBe("disconnected")
  })

  it("validates imported settings before one durable write and refuses replacing newer data", async () => {
    await expect(manager.importConnection(req, { ...mutation(), secret: token, selections: { account: "a", item: "not-listed" } }, options)).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(manager.connectionRevision).toBe(0)
    const imported = await manager.importConnection(req, { ...mutation(), secret: token, selections: { item: "x", account: "a" } }, options)
    expect(imported.connections[0]).toMatchObject({ status: "connected", selected: { account: { id: "a" }, item: { id: "x" } } })
    await expect(manager.importConnection(req, { ...mutation(), secret: "other-private-token", selections: {} }, options)).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
  })

  it("finishes an interrupted clear on startup before exposing stored state", async () => {
    await configure()
    const activation = await lease()
    await manager.call(req, activation.id, request("storage.set", { key: "setting", value: 42 }))
    await manager.close()
    const connections = await PluginConnectionStore.open(join(directory, "runtime-plugin-connections"), () => {})
    await connections.beginClear({ principalId: "owner", publisher: "dev-test", pluginId: installed.manifest.id }, connections.revision, authorize)
    await connections.close()
    manager = new PluginManager(join(directory, "runtime-plugins"), { transport }); await manager.initialize(); projects(); req = session()
    expect((await manager.listConnections(req, target())).connections[0].status).toBe("disconnected")
    expect(await manager.call(req, (await lease()).id, request("storage.get", { key: "setting" }))).toBeNull()
  })

  it.each(["preferred", "fallback"])("keeps %s environment credentials read-only and derives identity from that token", async source => {
    await manager.close()
    const roots = new Map([["cogpit", createRoot(authority)]])
    manager = new PluginManager(join(directory, "runtime-plugins"), { transport, officialRoots: roots, environment: {} }); await manager.initialize(); projects(); req = session()
    const declared = definition("clickup", "https://api.clickup.com")
    declared.auth.scheme = "raw"
    declared.operations.read.query = { actor: { identity: "user" } }
    const official = signedPackage(authority, { publisher: "cogpit", id: "cogpit.clickup", connection: declared })
    await install(official)
    const address = { pluginId: "cogpit.clickup", projectId: project1, connectionId: "clickup" }
    await manager.setCredential(req, { ...address, secret: token, expectedRevision: manager.connectionRevision }, options)
    await manager.selectResource(req, { ...address, resourceId: "account", value: "a", expectedRevision: manager.connectionRevision }, options)
    await manager.selectResource(req, { ...address, resourceId: "item", value: "x", expectedRevision: manager.connectionRevision }, options)
    await manager.close()
    const preferred = source === "preferred" ? "pk_environment_preferred_token" : "pk_fallback_never_used"
    transport.mockImplementation(async input => input.path === "/validate" ? { id: input.credential.secret === preferred ? "env-user" : "wrong-user" } : response(input.path))
    manager = new PluginManager(join(directory, "runtime-plugins"), { transport, officialRoots: roots, environment: { COGPIT_CLICKUP_TOKEN: source === "preferred" ? preferred : "invalid-token", CLICKUP_API_TOKEN: "pk_fallback_never_used" } }); await manager.initialize(); projects(); req = session()
    expect((await manager.listConnections(req, address)).connections[0]).toMatchObject({ status: "environment", readOnly: true })
    const activation = await manager.createLease(req, { ...address, contextEpoch: "env", client })
    await manager.call(req, activation.id, request("connections.request", { handle: "clickup", operationId: "read", args: {} }))
    expect(transport.mock.calls.at(-1)?.[0]).toMatchObject({ path: "/accounts/a/items/x/data?actor=env-user", credential: { secret: preferred } })
    await expect(manager.setCredential(req, { ...address, secret: "replacement-token", expectedRevision: manager.connectionRevision }, options)).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    await expect(manager.disconnect(req, { ...address, expectedRevision: manager.connectionRevision }, options)).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    const cleared = await manager.selectResource(req, { ...address, resourceId: "account", value: null, expectedRevision: manager.connectionRevision }, options)
    expect(cleared.connections[0]).toMatchObject({ status: "environment", readOnly: true, selected: {} })
    expect(await readFile(join(directory, "runtime-plugin-connections", "connections.json"), "utf8")).not.toContain(preferred)
  })
})
