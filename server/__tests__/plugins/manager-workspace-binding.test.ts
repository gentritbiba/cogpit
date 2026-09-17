// @vitest-environment node
import type { IncomingMessage } from "node:http"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseFrameMessage, parseManifest, type PluginRequest } from "@cogpit/plugin-contracts"

const inventory = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock("../../team/edition", () => ({ isTeamEdition: () => false }))
vi.mock("../../security", () => ({ onSessionRevoked: () => () => {}, isSessionTokenActive: () => true, getSessionPrincipal: () => null }))
vi.mock("../../routes/hello", () => ({ getInstanceId: () => "workspace-host", getAppVersion: () => "2.6.6" }))
vi.mock("../../agents", () => ({ allStores: () => [{ listProjects: async () => inventory.paths.map(path => ({ dirName: "fixture", path, sessionCount: 1, lastModified: null })) }] }))
import { setRequestAuthentication } from "../../requestAuthentication"
import { PluginManager } from "../../plugins/manager"
import type { PluginIntegrationExecutor } from "../../plugins/integrationTypes"
import { createAuthority, createBundle, createRoot, replaceTargets, sha256 } from "./fixtures/signing"
import { authorize, client, signedPackage } from "./fixtures/storeSigning"

let root: string
let workspace: string
let nested: string
let outside: string
let projectId: string
let manager: PluginManager
let req: IncomingMessage
let executor: ReturnType<typeof vi.fn<PluginIntegrationExecutor>>
const pluginId = "dev-test.probe"
const operation = { integration: "github", operation: "actions" } as const
const frameRequest = (params: object = operation): PluginRequest => parseFrameMessage({ protocol: 1, type: "request", id: "integration", method: "integrations.request", params }) as PluginRequest
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

async function lease(path: string | null = nested) {
  return manager.createLease(req, { pluginId, projectId, workspacePath: path, contextEpoch: "workspace-epoch", client })
}

beforeEach(async () => {
  vi.stubEnv("COGPIT_DISABLE_PLUGINS", "0")
  root = await realpath(await mkdtemp(join(tmpdir(), "cogpit-manager-workspace-")))
  workspace = join(root, "workspace"); nested = join(workspace, "apps", "web"); outside = join(root, "outside")
  await mkdir(nested, { recursive: true }); await mkdir(outside)
  inventory.paths = [workspace, outside]
  executor = vi.fn(async () => ({ repository: "fixture/repository", repositoryUrl: "https://github.com/fixture/repository", branch: "main", runs: [] }))
  manager = new PluginManager(join(root, "runtime-plugins"), { integrationExecutor: executor, environment: {} })
  await manager.initialize()
  projectId = (await manager.projects.list()).find(project => project.paths.includes(workspace))!.id
  req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage
  setRequestAuthentication(req, { kind: "local" })
  req.headers["x-cogpit-plugin-session"] = manager.authorization.createOrRenewSession(req).sessionId
  const authority = createAuthority()
  await manager.store.enrollDeveloper("dev-test", "Fixture", createRoot(authority), { authorize })
  const source = signedPackage(authority)
  const archive = JSON.parse(source.payload.toString("utf8")) as { archiveVersion: number; files: { path: string; mime: string; content: string }[] }
  const manifest = parseManifest({ ...source.manifest, permissions: { ...source.manifest.permissions, integrations: [{ id: "github", operations: ["actions", "pullSessions"] }], navigation: ["session"] } })
  archive.files.find(file => file.path === "plugin.json")!.content = Buffer.from(JSON.stringify(manifest)).toString("base64")
  const payload = Buffer.from(JSON.stringify(archive))
  const bundle = replaceTargets(createBundle(authority, { payload }), authority, value => {
    value.signed.targets = { [source.targetPath]: { length: payload.length, hashes: { sha256: sha256(payload) }, custom: { publisher: manifest.publisher, pluginId: manifest.id, version: manifest.version } } }
  })
  const bytes = Buffer.from(JSON.stringify({ bundleVersion: 1, publisher: manifest.publisher, targetPath: source.targetPath, roots: [], metadata: Object.fromEntries([...bundle.metadata].map(([name, value]) => [name, value.toString("utf8")])), payload: payload.toString("base64") }))
  const owner = manager.authorization.resolve(req).sessionId
  const preview = await manager.store.stage(bytes, { owner, client, scope: { type: "all" }, authorize })
  await manager.store.payload(preview.transactionId, owner)
  await manager.store.beginTrial(preview.transactionId, owner, { authorize })
  await manager.store.commit(preview.transactionId, owner, { expectedRevision: preview.registryRevision, authorize })
})
afterEach(async () => { await manager.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe("manager workspace-bound integrations", () => {
  it("acknowledges readiness without loading package data or enumerating projects again", async () => {
    const activation = await lease()
    const payload = vi.spyOn(manager.store, "payload"), inventory = vi.spyOn(manager.projects, "resolveWorkspace")
    const ready: PluginRequest = { protocol: 1, type: "request", id: "ready", method: "lifecycle.ready", params: {} }
    expect(await manager.call(req, activation.id, ready)).toBeNull()
    expect(payload).not.toHaveBeenCalled()
    expect(inventory).not.toHaveBeenCalled()
    await manager.store.setEnabled(pluginId, false, { expectedRevision: manager.snapshot().revision, authorize })
    await expect(manager.call(req, activation.id, ready)).rejects.toThrow()
  })
  it("passes the exact canonical nested workspace to runtime and legacy providers", async () => {
    const alias = join(root, "alias")
    await symlink(nested, alias, "dir")
    const activation = await lease(alias)
    expect(activation.workspacePath).toBe(nested)
    expect(await manager.call(req, activation.id, frameRequest())).toMatchObject({ ok: true, data: { branch: "main" } })
    expect(executor.mock.calls[0][0]).toEqual(operation)
    expect(executor.mock.calls[0][1].workspacePath).toBe(nested)
    expect(await manager.runLegacyIntegration(req, { pluginId, projectPath: alias }, operation)).toMatchObject({ branch: "main" })
    expect(executor.mock.calls[1][1].workspacePath).toBe(nested)
    await expect(manager.renewLease(req, activation.id)).resolves.toMatchObject({ id: activation.id, workspacePath: nested })
  })

  it("rejects cross-project lease paths and workspace-free integration calls", async () => {
    await expect(lease(outside)).rejects.toThrow(/workspace/)
    const activation = await lease(null)
    await expect(manager.call(req, activation.id, frameRequest())).rejects.toMatchObject({ code: "RESOURCE_REQUIRED" })
    expect(executor).not.toHaveBeenCalled()
  })

  it("rejects relative legacy workspace paths before calling the provider", async () => {
    await expect(manager.runLegacyIntegration(req, { pluginId, projectPath: "." }, operation)).rejects.toMatchObject({ code: "RESOURCE_REQUIRED" })
    expect(executor).not.toHaveBeenCalled()
  })

  it("rejects undeclared operations and caller-provided cwd before invoking the provider", async () => {
    const activation = await lease()
    await expect(manager.call(req, activation.id, frameRequest({ integration: "github", operation: "issues" }))).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    expect(() => frameRequest({ ...operation, cwd: outside })).toThrow()
    const forged = { ...frameRequest(), params: { ...operation, cwd: outside } } as unknown as PluginRequest
    await expect(manager.call(req, activation.id, forged)).rejects.toThrow()
    await expect(manager.runLegacyIntegration(req, { pluginId, projectPath: nested }, { integration: "github", operation: "issues" })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" })
    expect(executor).not.toHaveBeenCalled()
  })

  it("rechecks workspace ownership before renewing or invoking a provider", async () => {
    const activation = await lease()
    inventory.paths.push(nested)
    await expect(manager.renewLease(req, activation.id)).rejects.toThrow(/workspace/)
    await expect(manager.call(req, activation.id, frameRequest())).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(executor).not.toHaveBeenCalled()
  })

  it.each(["disable", "revoke", "workspace", "safe mode"] as const)("rejects a late runtime result after %s", async change => {
    const activation = await lease(), started = deferred<void>(), finish = deferred<unknown>()
    executor.mockImplementationOnce(async (_request, context) => { expect(context.workspacePath).toBe(nested); started.resolve(); return finish.promise })
    const running = manager.call(req, activation.id, frameRequest()).then(value => ({ value }), error => ({ error }))
    await started.promise
    if (change === "disable") await manager.store.setEnabled(pluginId, false, { expectedRevision: manager.snapshot().revision, authorize })
    else if (change === "revoke") manager.authorization.revokeSession(req)
    else if (change === "workspace") inventory.paths.push(nested)
    else vi.stubEnv("COGPIT_DISABLE_PLUGINS", "1")
    finish.resolve({ sensitiveLateResult: true })
    expect(await running).toHaveProperty("error")
    if (change === "disable" || change === "revoke") expect(executor.mock.calls[0][1].signal.aborted).toBe(true)
    await expect(executor.mock.calls[0][1].authorize()).rejects.toThrow()
  })

  it("applies disable cancellation and workspace validation to legacy provider calls", async () => {
    const started = deferred<void>(), finish = deferred<unknown>()
    executor.mockImplementationOnce(async (_request, context) => { expect(context.workspacePath).toBe(nested); started.resolve(); return finish.promise })
    const running = manager.runLegacyIntegration(req, { pluginId, projectPath: nested }, operation).then(value => ({ value }), error => ({ error }))
    await started.promise
    await manager.store.setEnabled(pluginId, false, { expectedRevision: manager.snapshot().revision, authorize })
    expect(executor.mock.calls[0][1].signal.aborted).toBe(true)
    finish.resolve({ sensitiveLateResult: true })
    expect(await running).toHaveProperty("error")
    await expect(manager.runLegacyIntegration(req, { pluginId, projectPath: nested }, operation)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it("exposes opaque session handles only in runtime results and keeps legacy DTOs unchanged", async () => {
    const data = { repository: "fixture/repository", pending: 0, sessions: [{ dirName: "private-storage-dir", fileName: "private-session.jsonl", sessionId: "private-session-id", title: "Session title", numbers: [7] }] }
    executor.mockResolvedValue(data)
    const activation = await lease()
    const result = await manager.call(req, activation.id, frameRequest({ integration: "github", operation: "pullSessions" }))
    expect(result).toMatchObject({ ok: true, data: { sessions: [{ title: "Session title", numbers: [7], handle: expect.any(String) }] } })
    expect(JSON.stringify(result)).not.toContain("private-")
    expect(await manager.runLegacyIntegration(req, { pluginId, projectPath: nested }, { integration: "github", operation: "pullSessions" })).toEqual(data)
  })
})
