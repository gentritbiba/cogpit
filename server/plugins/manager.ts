import { dirname, isAbsolute, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import type { IncomingMessage } from "node:http"
import { connectionResourceDependencies, evaluateCompatibility, parseIntegrationRequest, parseJson, parseMethodResult, type PluginIntegrationRequest, type ClientRuntimeDescriptor, type ConnectionDefinition, type JsonValue, type PluginRequest } from "@cogpit/plugin-contracts"
import type { PluginScope, PluginStoreSnapshot } from "../../shared/contracts/plugins"
import type { PluginConnectionSnapshot, PluginConnectionTarget, PluginResourceSelection } from "../../shared/contracts/pluginConnections"
import { getInstanceId } from "../routes/hello"
import { PluginAuthorization, PluginAuthorizationError, requirePluginAuthentication, samePluginAuthentication, type PluginAuthorizationBinding } from "./authorization"
import { PluginLeaseManager, type PluginLease } from "./leases"
import { PluginProjects } from "./projects"
import { pluginRuntimeDescriptor } from "./runtime"
import { openPluginStore, type PluginStore } from "./store"
import { inspectPackage } from "./package"
import { PluginConnectionStore, type PluginDataNamespace, type SavedPluginConnection } from "./connectionStore"
import { PluginStateStore } from "./stateStore"
import { PluginDataError, type DataGuard } from "./privateStore"
import { createConnectionExecutor, type ConnectionTransport, type HostConnection, type ConnectionResult, type ResourceOption } from "./connectionExecutor"
import { pluginHttpsTransport } from "./httpsTransport"
import type { AppPluginSeed } from "./seeds"
import type { LegacyHostClassification } from "./legacyHost"
import { setRequestAuthentication, clearRequestAuthentication } from "../requestAuthentication"
import { editionOwnsSignIn } from "../edition"
import { backupLegacyClickUpConfig, isClickUpToken, readLegacyClickUpConfig } from "../lib/clickupConfig"
import { executeGitHubIntegration, GitHubRouteError } from "./integrations/github"
import { executeVercelIntegration, VercelDeploymentsRouteError } from "./integrations/vercel"
import { CloudflareRouteError, executeCloudflareIntegration } from "./integrations/cloudflare"
import type { PluginIntegrationExecutor } from "./integrationTypes"
import { PluginSessionNavigation } from "./sessionNavigation"
import type { GitHubPullSessionsResponse } from "../../shared/contracts/github"
import { legacyProjectLink, projectForPath, validateLegacyClickUp } from "./legacyClickUp"

export interface PluginManagerOptions { integrationExecutor?: PluginIntegrationExecutor; transport?: ConnectionTransport; environment?: Readonly<Record<string, string | undefined>>; officialRoots?: ReadonlyMap<string, Buffer>; appSeeds?: readonly AppPluginSeed[]; legacyHost?: LegacyHostClassification; crashHook?: (step: string) => void | Promise<void> }
export interface PluginAdminOptions { authorize: DataGuard; signal?: AbortSignal }
export type PluginUninstallInput = { pluginId: string; expectedRevision: number } & ({ deleteData?: false } | { deleteData: true; expectedConnectionRevision: number })
export interface LegacyPluginCaller { request: IncomingMessage; projectId: string | null; projectPath: string | null; options: PluginAdminOptions; call: (operation: string, args: Record<string, string | number | boolean>) => Promise<JsonValue> }
type ConnectionTarget = PluginConnectionTarget & { connectionId: string }
type ConnectionMutation = ConnectionTarget & { expectedRevision: number }
const allowed = () => {}
const LEGACY_IMPORT_WARNING = "Legacy ClickUp settings could not be imported. Connect ClickUp or import the saved settings from Connections."
const unavailable = (): never => { throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Plugin capability is unavailable") }
const canceled = (): never => { throw new PluginDataError("CANCELED", "Plugin operation was canceled") }
function result<T>(value: ConnectionResult<T>): T {
  if (value.ok) return value.data
  throw new PluginDataError(value.error, value.error === "RESOURCE_REQUIRED" ? "Select the required connection resources" : "Connection operation failed")
}
function definitionFingerprint(value: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
}

export class PluginManager {
  readonly authorization = new PluginAuthorization({ hostInstanceId: getInstanceId() })
  readonly leases = new PluginLeaseManager(this.authorization)
  readonly projects = new PluginProjects()
  private readonly sessionNavigation = new PluginSessionNavigation()
  private storeValue: PluginStore | null = null
  private error: string | undefined
  private migrationIssue: string | undefined
  private closed = false
  private connections?: PluginConnectionStore
  private state?: PluginStateStore
  private readonly environmentToken: string | undefined
  private providerActive = 0
  private readonly providerLimits = new Map<string, { active: number; calls: number; startedAt: number }>()
  private readonly installationChanges = new Set<string>()
  private dataDeletionQueue: Promise<void> = Promise.resolve()
  private readonly legacyRateKeys = new Map<string, string>()
  private readonly root: string

  constructor(root: string, private readonly options: PluginManagerOptions = {}) {
    this.root = resolve(root)
    const environment = options.environment ?? process.env
    this.environmentToken = [environment.COGPIT_CLICKUP_TOKEN?.trim(), environment.CLICKUP_API_TOKEN?.trim()].find(isClickUpToken)
  }

  async initialize(): Promise<void> {
    try {
      this.storeValue = await openPluginStore(this.root, {
        host: pluginRuntimeDescriptor(),
        officialRoots: this.options.officialRoots,
        appSeeds: this.options.appSeeds,
        legacyHost: this.options.legacyHost,
        crashHook: this.options.crashHook,
        beforeChange: async (pluginId) => { this.installationChanges.add(pluginId); this.leases.revokeMatching({ pluginId }); await Promise.all([this.connections?.drain(), this.state?.drain()]) },
        afterMutation: () => this.installationChanges.clear(),
        onCompromised: () => this.leases.revokeMatching({}),
      })
      if (!this.storeValue.snapshot().available) return
      const compromised = () => { this.error = "Plugin private storage is unavailable"; this.leases.revokeMatching({}) }
      this.connections = await PluginConnectionStore.open(join(dirname(this.root), "runtime-plugin-connections"), () => this.leases.revokeMatching({}), this.options.crashHook, compromised)
      this.state = await PluginStateStore.open(join(this.root, "state"), compromised, this.options.crashHook)
      for (const scope of this.connections.pendingClears()) { await this.state.clear(scope); await this.connections.finishClear(scope) }
      await this.completeDataDeletions()
      if (this.connections.legacy()?.automaticFailed) this.reportMigrationIssue(LEGACY_IMPORT_WARNING)
    } catch {
      this.error = "Plugin private storage is unavailable"
      await this.connections?.close()
      await this.state?.close()
    }
  }

  get store(): PluginStore {
    if (this.closed || !this.storeValue || this.error) throw new PluginAuthorizationError(503, "STALE_ACTIVATION", this.error ?? "Plugin storage is unavailable")
    return this.storeValue
  }

  snapshot(): PluginStoreSnapshot {
    if (this.error) return { available: false, error: this.error, recoveryCode: "STORE_UNAVAILABLE", revision: 0, plugins: [], publishers: [] }
    const snapshot = this.storeValue?.snapshot() ?? { available: false, error: "Plugin storage is unavailable", revision: 0, plugins: [], publishers: [] }
    return snapshot.available && this.migrationIssue ? { ...snapshot, error: this.migrationIssue } : snapshot
  }
  reportMigrationIssue(message: string): void { this.migrationIssue = message.slice(0, 500) }
  get connectionRevision(): number { try { return this.connections?.revision ?? 0 } catch { return 0 } }

  get safeMode(): boolean { return process.env.COGPIT_DISABLE_PLUGINS === "1" }

  authorize(req: IncomingMessage, binding: PluginAuthorizationBinding): () => void {
    return () => {
      if (this.closed || this.authorization.resolve(req) !== binding) throw new PluginAuthorizationError(409, "STALE_ACTIVATION", "Plugin session changed")
    }
  }

  async validateScope(scope: PluginScope): Promise<void> {
    if (scope.type === "projects") {
      for (const id of scope.projectIds) await this.projects.resolve(id)
    }
  }

  async createLease(req: IncomingMessage, input: { pluginId: string; projectId: string | null; workspacePath?: string | null; contextEpoch: string; client: ClientRuntimeDescriptor }): Promise<PluginLease> {
    const binding = this.authorization.resolve(req)
    const { project, workspacePath } = await this.projects.resolveContext(input.projectId, input.workspacePath)
    this.authorize(req, binding)()
    const snapshot = this.snapshot()
    if (!snapshot.available || this.safeMode) throw new PluginAuthorizationError(409, "STALE_ACTIVATION", "Plugin execution is disabled on this host")
    const plugin = snapshot.plugins.find((candidate) => candidate.id === input.pluginId)
    if (this.connections?.changing || this.installationChanges.has(input.pluginId)) throw new PluginDataError("STALE_ACTIVATION", "Plugin configuration is changing")
    if (!plugin?.enabled) throw new PluginAuthorizationError(409, "STALE_ACTIVATION", "Plugin is disabled or uninstalled")
    if (plugin.scope.type !== "all" && (!project || !plugin.scope.projectIds.includes(project.id))) throw new PluginAuthorizationError(403, "PERMISSION_REQUIRED", "Plugin is hidden in this project")
    const compatibility = evaluateCompatibility(plugin.manifest, input.client, pluginRuntimeDescriptor(snapshot.revision), { allowPrerelease: plugin.manifest.publisher.startsWith("dev-") })
    if (!compatibility.compatible) throw new PluginAuthorizationError(409, "STALE_ACTIVATION", compatibility.issues.map((issue) => `${issue.side}: ${issue.name} requires ${issue.required}`).join("; ").slice(0, 500))
    const guard = () => {
      this.authorize(req, binding)()
      const current = this.snapshot(), selected = current.plugins.find(value => value.id === plugin.id)
      if (!current.available || this.safeMode || this.installationChanges.has(plugin.id) || !selected?.enabled || selected.selectedDigest !== plugin.selectedDigest || current.revision !== snapshot.revision) throw new PluginDataError("STALE_ACTIVATION", "Plugin installation or permissions changed")
      if (selected.scope.type !== "all" && (!project || !selected.scope.projectIds.includes(project.id))) throw new PluginDataError("PERMISSION_REQUIRED", "Plugin is hidden in this project")
    }
    if (await this.maybeImportLegacy(req, input, { authorize: guard })) await this.projects.resolveContext(input.projectId, workspacePath)
    guard()
    return this.leases.create(binding, { pluginId: plugin.id, digest: plugin.selectedDigest, projectKey: project?.id ?? null, workspacePath, contextEpoch: input.contextEpoch, grantsRevision: snapshot.revision, connectionRevision: this.connectionRevision })
  }

  resolveLease(req: IncomingMessage, id: string): PluginLease {
    const binding = this.authorization.resolve(req)
    const lease = this.leases.resolve(binding, id)
    const snapshot = this.snapshot()
    const installed = snapshot.plugins.find((plugin) => plugin.id === lease.pluginId)
    if (this.safeMode || !snapshot.available || this.connections?.changing || this.installationChanges.has(lease.pluginId) || !installed?.enabled || installed.selectedDigest !== lease.digest || snapshot.revision !== lease.grantsRevision || lease.connectionRevision !== this.connectionRevision) {
      this.leases.revoke(binding, id)
      throw new PluginAuthorizationError(409, "STALE_ACTIVATION", "Plugin installation or permissions changed")
    }
    return lease
  }

  private async context(req: IncomingMessage, target: PluginConnectionTarget, options: PluginAdminOptions, lease?: PluginLease) {
    const binding = this.authorization.resolve(req)
    const snapshot = this.snapshot()
    const plugin = snapshot.plugins.find(value => value.id === target.pluginId)
    if (!snapshot.available || !plugin || !this.connections || !this.state) return unavailable()
    const revision = this.connections.revision
    const abort = new AbortController()
    let disposed = false
    const unsubscribe = this.authorization.onRevoked(id => { if (id === binding.sessionId) abort.abort() })
    const signal = AbortSignal.any([abort.signal, ...options.signal ? [options.signal] : [], ...lease ? [lease.signal] : []])
    const scope: PluginDataNamespace = { principalId: binding.principalId, publisher: plugin.manifest.publisher, pluginId: plugin.id }
    const check = () => {
      if (disposed || signal.aborted) return canceled()
      this.authorization.assertBinding(binding)
      const current = this.snapshot()
      const selected = current.plugins.find(value => value.id === plugin.id)
      if (!current.available || this.installationChanges.has(plugin.id) || !selected || selected.selectedDigest !== plugin.selectedDigest || current.revision !== snapshot.revision || this.connections!.revision !== revision) throw new PluginDataError("STALE_ACTIVATION", "Plugin installation or connection changed")
      if (lease) this.resolveLease(req, lease.id)
    }
    const guard = async () => {
      await options.authorize()
      check()
      try {
        if (lease?.workspacePath) await this.projects.resolveWorkspace(target.projectId, lease.workspacePath)
        else await this.projects.resolve(target.projectId)
      } catch { throw new PluginDataError("STALE_ACTIVATION", "The selected project is unavailable") }
      check()
    }
    try {
      await guard()
      const payload = await this.store.payload(plugin.selectedDigest)
      check()
      const inspected = inspectPackage(payload, plugin.manifest.publisher)
      return { binding, plugin, revision, scope, inspected, projectId: target.projectId, workspacePath: lease?.workspacePath ?? null, signal, guard, check, leaseId: lease?.id, dispose: () => { disposed = true; unsubscribe() } }
    } catch (error) { unsubscribe(); if (error instanceof PluginDataError || error instanceof PluginAuthorizationError) throw error; return unavailable() }
  }

  private connection(context: Awaited<ReturnType<PluginManager["context"]>>, id: string) {
    const definition = context.inspected.connections.get(id)
    const grant = context.plugin.manifest.permissions.connections.find(value => value.id === id)
    if (!definition || !grant) throw new PluginDataError("PERMISSION_REQUIRED", "The package does not declare this connection")
    const definitionHash = definitionFingerprint(definition)
    const saved = this.connections!.get(context.scope, id, definitionHash)
    const environment = this.isOfficialClickUp(context, definition) ? this.environmentToken : undefined
    const selected = Object.fromEntries(Object.entries({ ...saved?.selected, ...context.projectId ? saved?.projects[context.projectId] : {} }).filter(([id]) => Object.hasOwn(definition.resources, id)))
    const connection: HostConnection = { label: definition.label, secret: environment ?? saved?.secret ?? "", selected, identity: environment ? {} : saved?.identity ?? {} }
    return { definition, definitionHash, grant, saved, environment, connection }
  }
  private isOfficialClickUp(context: Awaited<ReturnType<PluginManager["context"]>>, definition: ConnectionDefinition): boolean {
    return context.plugin.id === "cogpit.clickup" && context.plugin.manifest.publisher === "cogpit" && definition.id === "clickup"
      && this.snapshot().publishers.some(value => value.id === "cogpit" && value.kind === "official")
      && definition.auth.header === "Authorization" && definition.auth.scheme === "raw"
      && Object.values(definition.operations).every(operation => operation.origin === "https://api.clickup.com")
  }
  private async executor(context: Awaited<ReturnType<PluginManager["context"]>>, value: ReturnType<PluginManager["connection"]>) {
    const options = { transport: this.options.transport ?? pluginHttpsTransport, allowedOperations: value.grant.operations, signal: context.signal }
    const executor = createConnectionExecutor(value.definition, value.connection, options)
    if (!value.environment) return executor
    const validated = result(await executor.validate())
    await context.guard()
    return createConnectionExecutor(value.definition, { ...value.connection, identity: validated.identity }, options)
  }
  private async provider<T>(context: Awaited<ReturnType<PluginManager["context"]>>, operation: () => Promise<T>): Promise<T> {
    const now = Date.now(), key = this.legacyRateKeys.get(context.binding.sessionId) ?? context.leaseId ?? context.binding.sessionId
    for (const [key, value] of this.providerLimits) if (value.active === 0 && value.startedAt + 60000 <= now) this.providerLimits.delete(key)
    const limit = this.providerLimits.get(key) ?? { active: 0, calls: 0, startedAt: now }
    if (limit.active >= 8 || this.providerActive >= 32 || limit.calls >= 120) throw new PluginDataError("RATE_LIMITED", "Too many connection operations")
    limit.active++; limit.calls++; this.providerActive++; this.providerLimits.set(key, limit)
    try { const value = await operation(); await context.guard(); return value } finally { limit.active--; this.providerActive-- }
  }
  async prepareLegacyClickUp(input: { path: string; classification: LegacyHostClassification; principalId?: string; authorize: DataGuard }): Promise<void> {
    if (input.classification.classification !== "legacy") return
    if (!this.connections || !this.snapshot().available) return unavailable()
    await input.authorize()
    const source = await readLegacyClickUpConfig(input.path)
    await input.authorize()
    if (!source) return
    const previous = this.connections.legacy()
    if (previous?.hash === source.hash) return
    const revision = this.connections.revision, preparedAt = Date.now()
    const backup = await backupLegacyClickUpConfig(input.path, source, preparedAt, input.authorize)
    await this.connections.prepareLegacy({ hash: source.hash, backup, preparedAt, token: source.token, projects: source.projects, principalId: input.principalId ?? (editionOwnsSignIn() ? null : "owner"), automatic: !previous && !editionOwnsSignIn(), automaticFailed: false, credentialImported: false, environmentPrepared: false, importedProjects: [], decidedProjects: [], suppressed: false }, revision, input.authorize)
  }
  private async maybeImportLegacy(req: IncomingMessage, target: PluginConnectionTarget, options: PluginAdminOptions): Promise<boolean> {
    if (target.pluginId !== "cogpit.clickup") return false
    const source = this.connections?.legacy()
    if (!source?.automatic || source.suppressed || source.principalId !== this.authorization.resolve(req).principalId) return false
    if ((source.credentialImported || this.environmentToken && source.environmentPrepared)
      && (target.projectId === null || source.decidedProjects.includes(target.projectId))) return false
    const binding = this.authorization.resolve(req)
    const installed = this.snapshot().plugins.find(plugin => plugin.id === target.pluginId)
    if (!installed?.enabled || this.safeMode) return false
    const registryRevision = this.snapshot().revision
    const guard = async () => {
      await options.authorize()
      if (options.signal?.aborted) return canceled()
      this.authorize(req, binding)()
      const current = this.snapshot(), plugin = current.plugins.find(value => value.id === target.pluginId)
      if (!current.available || this.safeMode || !plugin?.enabled || plugin.selectedDigest !== installed.selectedDigest || current.revision !== registryRevision) throw new PluginDataError("STALE_ACTIVATION", "Plugin changed during legacy import")
    }
    const guarded = { ...options, authorize: guard }
    const context = await this.context(req, target, guarded)
    try {
      const value = this.connection(context, "clickup")
      if (!this.isOfficialClickUp(context, value.definition)) return false
      if (!source.credentialImported && value.saved?.secret) return false
      if (source.credentialImported && !value.connection.secret || !source.token && !value.connection.secret) return false
      const project = await this.projects.resolve(target.projectId)
      await context.guard()
      const link = await legacyProjectLink(source, project, await this.projects.list(true))
      await context.guard()
      if ((source.credentialImported || value.environment && source.environmentPrepared) && (!link || value.connection.selected.list)) return false
    } finally { context.dispose() }
    const expectedRevision = this.connectionRevision
    try { await this.performLegacyImport(req, { ...target, connectionId: "clickup", expectedRevision }, guarded) }
    catch (error) {
      if (!(error instanceof PluginDataError) || !["UPSTREAM_FAILED", "INVALID_RESPONSE", "TIMEOUT", "NETWORK_DENIED", "RESOURCE_REQUIRED", "CONNECTION_REQUIRED"].includes(error.code)) throw error
      if (options.signal?.aborted) return canceled()
      await this.connections!.pauseLegacy(source.hash, expectedRevision, guard)
      this.reportMigrationIssue(LEGACY_IMPORT_WARNING)
    }
    return true
  }
  private async performLegacyImport(req: IncomingMessage, input: ConnectionMutation & { replaceExisting?: boolean }, options: PluginAdminOptions): Promise<void> {
    if (input.pluginId !== "cogpit.clickup" || input.connectionId !== "clickup") throw new PluginDataError("INVALID_REQUEST", "This connection has no legacy importer")
    const context = await this.context(req, input, options)
    try {
      const source = this.connections!.legacy()
      if (!source || source.suppressed || source.principalId && source.principalId !== context.binding.principalId) throw new PluginDataError("PERMISSION_REQUIRED", "No legacy connection is available for this principal")
      if (input.expectedRevision !== context.revision) throw new PluginDataError("STALE_ACTIVATION", "Plugin saved data changed; refresh and retry")
      const value = this.connection(context, input.connectionId)
      if (!this.isOfficialClickUp(context, value.definition)) throw new PluginDataError("PERMISSION_REQUIRED", "Legacy credentials require the original ClickUp service definition")
      if (value.saved?.secret && !source.credentialImported && !input.replaceExisting) throw new PluginDataError("PERMISSION_REQUIRED", "Import would replace existing connection settings")
      const secret = value.environment ?? (source.credentialImported ? value.saved?.secret : source.token)
      if (!secret) throw new PluginDataError("CONNECTION_REQUIRED", "Configure a credential before importing project links")
      const project = await this.projects.resolve(input.projectId)
      await context.guard()
      const link = await legacyProjectLink(source, project, await this.projects.list(true))
      await context.guard()
      const importGuard = async () => {
        await context.guard()
        if (link) {
          const projects = await this.projects.list(true)
          let canonical: string
          try { canonical = await realpath(link.path) } catch { throw new PluginDataError("STALE_ACTIVATION", "The legacy project is unavailable") }
          if (projectForPath(canonical, projects)?.id !== input.projectId) throw new PluginDataError("STALE_ACTIVATION", "The legacy project identity changed")
          await context.guard()
        }
      }
      if (link && value.connection.selected.list && !input.replaceExisting) throw new PluginDataError("PERMISSION_REQUIRED", "Import would replace this project's selected list")
      const reuse = source.credentialImported || !!value.environment || source.environmentPrepared
      const connection: HostConnection = { label: value.definition.label, secret, identity: {}, selected: reuse ? { ...value.connection.selected } : {} }
      if (input.replaceExisting) { delete connection.selected.space; delete connection.selected.list }
      const resetUnavailableWorkspace = source.environmentPrepared && !value.environment && !source.credentialImported
      const validated = await this.provider(context, () => validateLegacyClickUp({ definition: value.definition, connection, listId: link?.list, resetUnavailableWorkspace, transport: this.options.transport ?? pluginHttpsTransport, operations: value.grant.operations, signal: context.signal, guard: importGuard }))
      const selected = Object.fromEntries(Object.entries(validated.selected).filter(([id]) => value.definition.resources[id]?.scope === "connection"))
      const projects = reuse ? structuredClone(value.saved?.projects ?? {}) : {}
      if (selected.workspace?.id !== value.saved?.selected.workspace?.id) for (const id of Object.keys(projects)) delete projects[id]
      if (input.projectId && link) projects[input.projectId] = Object.fromEntries(Object.entries(validated.selected).filter(([id]) => value.definition.resources[id]?.scope === "project"))
      await this.connections!.set(context.scope, input.connectionId, { definitionHash: value.definitionHash, ...value.environment ? value.saved?.secret ? { secret: value.saved.secret } : {} : { secret }, identity: value.environment ? value.saved?.identity ?? {} : validated.identity ?? {}, selected, projects }, input.expectedRevision, importGuard, { hash: source.hash, principalId: context.binding.principalId, projectPath: link?.path, projectId: link ? input.projectId ?? undefined : undefined, credentialImported: !value.environment || !source.token || !!value.saved?.secret, environmentPrepared: !!value.environment })
      if (this.migrationIssue === LEGACY_IMPORT_WARNING) this.migrationIssue = undefined
    } finally { context.dispose() }
  }
  async importLegacyConnection(req: IncomingMessage, input: ConnectionMutation & { replaceExisting?: boolean }, options: PluginAdminOptions): Promise<PluginConnectionSnapshot> {
    await this.performLegacyImport(req, input, options)
    return this.listConnections(req, input, options)
  }
  async withLegacyPlugin<T>(req: IncomingMessage, input: { pluginId: string; projectPath?: string; signal?: AbortSignal }, operation: (caller: LegacyPluginCaller) => Promise<T>): Promise<T> {
    const authentication = requirePluginAuthentication(req)
    const request = Object.assign(Object.create(req), { headers: { ...req.headers } }) as IncomingMessage
    delete request.headers["x-cogpit-plugin-session"]
    setRequestAuthentication(request, authentication)
    request.headers["x-cogpit-plugin-session"] = this.authorization.createOrRenewSession(request).sessionId
    const binding = this.authorization.resolve(request)
    this.legacyRateKeys.set(binding.sessionId, `legacy:${createHash("sha256").update(authentication.kind === "local" ? "owner" : authentication.token).digest("hex")}:${binding.principalId}`)
    try {
      let projectId: string | null = null, projectPath: string | null = null
      if (input.projectPath !== undefined) {
        if (!isAbsolute(input.projectPath)) throw new PluginDataError("RESOURCE_REQUIRED", "Choose an absolute workspace path")
        try { projectPath = await realpath(input.projectPath) } catch { throw new PluginDataError("RESOURCE_REQUIRED", "The selected project is unavailable") }
        const project = projectForPath(projectPath, await this.projects.list(true))
        if (!project) throw new PluginDataError("PERMISSION_REQUIRED", "The selected project is not available to plugins")
        projectId = project.id
      }
      const snapshot = this.snapshot(), plugin = snapshot.plugins.find(plugin => plugin.id === input.pluginId)
      if (!snapshot.available || !plugin?.enabled || this.safeMode) throw new PluginDataError("STALE_ACTIVATION", "This integration is disabled or unavailable")
      const check = () => {
        if (input.signal?.aborted) return canceled()
        if (!samePluginAuthentication(authentication, requirePluginAuthentication(req))) return canceled()
        this.authorize(request, binding)()
        const current = this.snapshot(), selected = current.plugins.find(plugin => plugin.id === input.pluginId)
        if (!current.available || !selected?.enabled || selected.selectedDigest !== plugin.selectedDigest || current.revision !== snapshot.revision || this.installationChanges.has(plugin.id) || this.safeMode) throw new PluginDataError("STALE_ACTIVATION", "This integration changed or was disabled")
        if (selected.scope.type !== "all" && (!projectId || !selected.scope.projectIds.includes(projectId))) throw new PluginDataError("PERMISSION_REQUIRED", "This integration is hidden in the selected project")
      }
      const guard = async () => {
        check()
        try {
          await this.projects.resolve(projectId)
          if (projectPath && projectForPath(await realpath(projectPath), await this.projects.list(true))?.id !== projectId) throw new Error("Project identity changed")
        } catch { throw new PluginDataError("RESOURCE_REQUIRED", "The selected project is unavailable") }
        check()
      }
      const options = { authorize: guard, signal: input.signal }
      await guard()
      await this.maybeImportLegacy(request, { pluginId: plugin.id, projectId }, options)
      await guard()
      const call = async (operation: string, args: Record<string, string | number | boolean>): Promise<JsonValue> => {
        await guard()
        if (this.connections?.changing) throw new PluginDataError("STALE_ACTIVATION", "Plugin configuration is changing")
        const lease = this.leases.create(binding, { pluginId: plugin.id, digest: plugin.selectedDigest, projectKey: projectId, workspacePath: projectPath, contextEpoch: "legacy", grantsRevision: snapshot.revision, connectionRevision: this.connectionRevision })
        try { const value = await this.call(request, lease.id, { protocol: 1, type: "request", id: "legacy", method: "connections.request", params: { handle: "clickup", operationId: operation, args } }, { signal: input.signal }); await guard(); return value }
        finally { try { this.leases.revoke(binding, lease.id) } catch { /* Revocation may already have canceled the operation. */ } }
      }
      const value = await operation({ request, projectId, projectPath, options, call })
      await guard()
      return value
    } finally {
      this.legacyRateKeys.delete(binding.sessionId)
      this.leases.revokeMatching({ sessionId: binding.sessionId })
      try { this.authorization.revokeSession(request) } catch { /* Authentication may already have revoked the session. */ }
      clearRequestAuthentication(request)
    }
  }
  async listConnections(req: IncomingMessage, target: PluginConnectionTarget, options: PluginAdminOptions = { authorize: allowed }): Promise<PluginConnectionSnapshot> {
    await this.maybeImportLegacy(req, target, options)
    const context = await this.context(req, target, options)
    try {
      return { revision: context.revision, connections: [...context.inspected.connections.keys()].map(id => {
        const value = this.connection(context, id)
        const legacy = this.connections?.legacy()
        const legacyImportAvailable = id === "clickup" && target.pluginId === "cogpit.clickup" && !!legacy && !legacy.suppressed && (!legacy.principalId || legacy.principalId === context.binding.principalId) && (!legacy.credentialImported || (!target.projectId || !legacy.decidedProjects.includes(target.projectId)) && Object.keys(legacy.projects).some(path => !legacy.importedProjects.includes(path)))
        return { id, label: value.definition.label, status: value.environment ? "environment" : value.saved?.secret ? "connected" : "disconnected", readOnly: !!value.environment, selected: value.connection.selected, definition: value.definition, legacyImportAvailable }
      }) }
    } finally { context.dispose() }
  }
  async setCredential(req: IncomingMessage, input: ConnectionMutation & { secret: string }, options: PluginAdminOptions): Promise<PluginConnectionSnapshot> {
    if (typeof input.secret !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(input.secret)) throw new PluginDataError("INVALID_REQUEST", "Invalid connection credential")
    const context = await this.context(req, input, options)
    try {
      const value = this.connection(context, input.connectionId)
      if (value.environment) throw new PluginDataError("PERMISSION_REQUIRED", "This credential is managed by the host environment")
      if (context.revision !== input.expectedRevision) throw new PluginDataError("STALE_ACTIVATION", "Plugin saved data changed; refresh and retry")
      const executor = createConnectionExecutor(value.definition, { label: value.definition.label, secret: input.secret, selected: {}, identity: {} }, { transport: this.options.transport ?? pluginHttpsTransport, allowedOperations: value.grant.operations, signal: context.signal })
      const validated = await this.provider(context, async () => result(await executor.validate()))
      await context.guard()
      await this.connections!.set(context.scope, input.connectionId, { definitionHash: value.definitionHash, secret: input.secret, identity: validated.identity, selected: {}, projects: {} }, input.expectedRevision, context.guard)
    } finally { context.dispose() }
    return this.listConnections(req, input, options)
  }
  async listResourceOptions(req: IncomingMessage, input: ConnectionTarget & { resourceId: string }, options: PluginAdminOptions): Promise<PluginResourceSelection[]> {
    const context = await this.context(req, input, options)
    try {
      const value = this.connection(context, input.connectionId)
      if (!value.connection.secret) throw new PluginDataError("CONNECTION_REQUIRED", "Configure this connection in host settings")
      const listed = await this.provider(context, async () => result(await (await this.executor(context, value)).listOptions(input.resourceId)))
      await context.guard()
      return listed
    } finally { context.dispose() }
  }
  async previewResourceOptions(req: IncomingMessage, input: ConnectionTarget & { resourceId: string; parents: Record<string, string> }, options: PluginAdminOptions): Promise<ResourceOption[]> {
    const context = await this.context(req, input, options)
    try {
      const value = this.connection(context, input.connectionId)
      if (!value.connection.secret) throw new PluginDataError("CONNECTION_REQUIRED", "Configure this connection in host settings")
      return await this.provider(context, async () => {
        let connection = structuredClone(value.connection)
        for (const [id, selected] of Object.entries(input.parents)) {
          if (!connectionResourceDependencies(value.definition, input.resourceId).includes(id)) throw new PluginDataError("INVALID_REQUEST", "Invalid parent selection")
          const executor = await this.executor(context, { ...value, connection })
          connection = { ...connection, selected: result(await executor.selectResource(id, selected)) }
          await context.guard()
        }
        return result(await (await this.executor(context, { ...value, connection })).listOptionsWithParents(input.resourceId))
      })
    } finally { context.dispose() }
  }
  async selectLegacyClickUpList(req: IncomingMessage, input: PluginConnectionTarget & { listId: string | null; expectedRevision: number }, options: PluginAdminOptions): Promise<PluginConnectionSnapshot> {
    if (input.pluginId !== "cogpit.clickup" || !input.projectId) throw new PluginDataError("INVALID_REQUEST", "A ClickUp project is required")
    if (input.listId === null) return this.selectResource(req, { ...input, connectionId: "clickup", resourceId: "list", value: null }, options)
    const context = await this.context(req, input, options)
    try {
      const value = this.connection(context, "clickup")
      if (context.revision !== input.expectedRevision) throw new PluginDataError("STALE_ACTIVATION", "Plugin saved data changed; refresh and retry")
      if (!value.connection.secret) throw new PluginDataError("CONNECTION_REQUIRED", "Configure this connection in host settings")
      const connection = structuredClone(value.connection)
      delete connection.selected.space; delete connection.selected.list
      const selected = await this.provider(context, () => validateLegacyClickUp({ definition: value.definition, connection, listId: input.listId!, transport: this.options.transport ?? pluginHttpsTransport, operations: value.grant.operations, signal: context.signal, guard: context.guard }))
      const projects = structuredClone(value.saved?.projects ?? {})
      projects[input.projectId] = Object.fromEntries(Object.entries(selected.selected).filter(([id]) => value.definition.resources[id]?.scope === "project"))
      await this.connections!.set(context.scope, "clickup", { ...value.saved, definitionHash: value.definitionHash, identity: value.saved?.identity ?? {}, selected: Object.fromEntries(Object.entries(selected.selected).filter(([id]) => value.definition.resources[id]?.scope === "connection")), projects }, input.expectedRevision, context.guard, undefined, input.projectId)
    } finally { context.dispose() }
    return this.listConnections(req, input, options)
  }
  async selectResource(req: IncomingMessage, input: ConnectionMutation & { resourceId: string; value: string | null }, options: PluginAdminOptions): Promise<PluginConnectionSnapshot> {
    const context = await this.context(req, input, options)
    try {
      const value = this.connection(context, input.connectionId)
      const resource = Object.hasOwn(value.definition.resources, input.resourceId) ? value.definition.resources[input.resourceId] : undefined
      if (!resource) throw new PluginDataError("INVALID_REQUEST", "Unknown connection resource")
      if (resource.scope === "project" && !input.projectId) throw new PluginDataError("RESOURCE_REQUIRED", "Select a project before configuring this resource")
      if (!value.connection.secret) throw new PluginDataError("CONNECTION_REQUIRED", "Configure this connection in host settings")
      if (context.revision !== input.expectedRevision) throw new PluginDataError("STALE_ACTIVATION", "Plugin saved data changed; refresh and retry")
      let selected = { ...value.connection.selected }
      if (input.value !== null) selected = await this.provider(context, async () => result(await (await this.executor(context, value)).selectResource(input.resourceId, input.value)))
      const removed = new Set([input.resourceId])
      let changed = input.value === null || selected[input.resourceId]?.id !== value.connection.selected[input.resourceId]?.id
      while (changed) { changed = false; for (const id of Object.keys(value.definition.resources)) if (!removed.has(id) && connectionResourceDependencies(value.definition, id).some(parent => removed.has(parent))) { removed.add(id); changed = true } }
      if (input.value === null) for (const id of removed) delete selected[id]
      await context.guard()
      const saved: Omit<SavedPluginConnection, keyof PluginDataNamespace | "connectionId"> = { ...value.saved, definitionHash: value.definitionHash, identity: value.saved?.identity ?? {}, selected: { ...value.saved?.selected }, projects: structuredClone(value.saved?.projects ?? {}) }
      for (const id of removed) {
        if (value.definition.resources[id]?.scope === "project") {
          if (resource.scope === "project") { if (input.projectId && saved.projects[input.projectId]) delete saved.projects[input.projectId][id] }
          else for (const project of Object.values(saved.projects)) delete project[id]
        } else delete saved.selected[id]
      }
      for (const [id, selection] of Object.entries(selected)) {
        if (value.definition.resources[id]?.scope === "project") { if (input.projectId) { saved.projects[input.projectId] ??= {}; saved.projects[input.projectId][id] = selection } }
        else saved.selected[id] = selection
      }
      await this.connections!.set(context.scope, input.connectionId, saved, input.expectedRevision, context.guard, undefined, resource.scope === "project" ? input.projectId ?? undefined : undefined)
    } finally { context.dispose() }
    return this.listConnections(req, input, options)
  }
  async disconnect(req: IncomingMessage, input: ConnectionMutation, options: PluginAdminOptions): Promise<PluginConnectionSnapshot> {
    const context = await this.context(req, input, options)
    try {
      if (this.connection(context, input.connectionId).environment) throw new PluginDataError("PERMISSION_REQUIRED", "This credential is managed by the host environment")
      await this.connections!.disconnect(context.scope, input.connectionId, input.expectedRevision, context.guard)
    } finally { context.dispose() }
    return this.listConnections(req, input, options)
  }
  async clearData(req: IncomingMessage, input: { pluginId: string; expectedRevision: number }, options: PluginAdminOptions): Promise<PluginConnectionSnapshot> {
    const context = await this.context(req, { pluginId: input.pluginId, projectId: null }, options)
    try {
      await this.connections!.beginClear(context.scope, input.expectedRevision, context.guard)
      await this.state!.clear(context.scope)
      await this.connections!.finishClear(context.scope)
    } finally { context.dispose() }
    return this.listConnections(req, { pluginId: input.pluginId, projectId: null })
  }
  private completeDataDeletions(): Promise<void> {
    const operation = this.dataDeletionQueue.then(async () => {
      for (;;) {
        const deletion = this.store.pendingDataDeletions()[0]
        if (!deletion) return
        const scope = { principalId: deletion.principalId, publisher: deletion.publisher, pluginId: deletion.pluginId }
        await this.connections!.beginClear(scope, undefined, allowed)
        await this.state!.clear(scope)
        await this.connections!.finishClear(scope)
        await this.store.finishDataDeletion(deletion.id)
      }
    })
    this.dataDeletionQueue = operation.catch(() => {})
    return operation
  }
  async uninstall(req: IncomingMessage, input: PluginUninstallInput, options: PluginAdminOptions): Promise<PluginStoreSnapshot> {
    const binding = this.authorization.resolve(req)
    const guard = async () => {
      await options.authorize()
      if (options.signal?.aborted) return canceled()
      this.authorize(req, binding)()
      if (input.deleteData && this.connectionRevision !== input.expectedConnectionRevision) throw new PluginDataError("STALE_ACTIVATION", "Plugin saved data changed; review uninstall again")
    }
    await guard()
    await this.store.uninstall(input.pluginId, { expectedRevision: input.expectedRevision, authorize: guard, ...(input.deleteData ? { deleteDataFor: binding.principalId } : {}) })
    if (input.deleteData) await this.completeDataDeletions()
    return this.snapshot()
  }
  async importConnection(req: IncomingMessage, input: ConnectionMutation & { secret: string; selections: Record<string, string> }, options: PluginAdminOptions): Promise<PluginConnectionSnapshot> {
    const context = await this.context(req, input, options)
    try {
      const value = this.connection(context, input.connectionId)
      if (value.environment || value.saved) throw new PluginDataError("PERMISSION_REQUIRED", "This connection already has host-owned configuration")
      if (context.revision !== input.expectedRevision) throw new PluginDataError("STALE_ACTIVATION", "Plugin saved data changed; refresh and retry")
      const entries = Object.entries(input.selections)
      if (entries.length > 8 || entries.some(([id]) => !Object.hasOwn(value.definition.resources, id))) throw new PluginDataError("INVALID_REQUEST", "Invalid imported resource selection")
      const connection: HostConnection = { label: value.definition.label, secret: input.secret, selected: {}, identity: {} }
      const executorOptions = { transport: this.options.transport ?? pluginHttpsTransport, allowedOperations: value.grant.operations, signal: context.signal }
      await this.provider(context, async () => {
        connection.identity = result(await createConnectionExecutor(value.definition, connection, executorOptions).validate()).identity
        await context.guard()
        while (entries.length) {
          const index = entries.findIndex(([id]) => connectionResourceDependencies(value.definition, id).every(parent => Object.hasOwn(connection.selected, parent)))
          if (index < 0) throw new PluginDataError("RESOURCE_REQUIRED", "Imported resources are missing required parents")
          const [id, selection] = entries.splice(index, 1)[0]
          if (value.definition.resources[id].scope === "project" && !input.projectId) throw new PluginDataError("RESOURCE_REQUIRED", "Select a project before importing this resource")
          connection.selected = result(await createConnectionExecutor(value.definition, connection, executorOptions).selectResource(id, selection))
          await context.guard()
        }
      })
      const selected = Object.fromEntries(Object.entries(connection.selected).filter(([id]) => value.definition.resources[id].scope !== "project"))
      const project = Object.fromEntries(Object.entries(connection.selected).filter(([id]) => value.definition.resources[id].scope === "project"))
      await this.connections!.set(context.scope, input.connectionId, { definitionHash: value.definitionHash, secret: input.secret, identity: connection.identity ?? {}, selected, projects: input.projectId ? { [input.projectId]: project } : {} }, input.expectedRevision, context.guard)
    } finally { context.dispose() }
    return this.listConnections(req, input, options)
  }
  async renewLease(req: IncomingMessage, id: string): Promise<PluginLease> {
    const lease = this.resolveLease(req, id)
    if (lease.workspacePath) await this.projects.resolveWorkspace(lease.projectKey, lease.workspacePath)
    else await this.projects.resolve(lease.projectKey)
    this.resolveLease(req, id)
    return this.leases.renew(this.authorization.resolve(req), id)
  }

  private async integration(context: Awaited<ReturnType<PluginManager["context"]>>, input: PluginIntegrationRequest, executor = this.options.integrationExecutor): Promise<unknown> {
    const request = parseIntegrationRequest(input)
    const grant = context.plugin.manifest.permissions.integrations.find(value => value.id === request.integration)
    if (!grant || !(grant.operations as readonly string[]).includes(request.operation)) throw new PluginDataError("PERMISSION_REQUIRED", "This plugin has not been granted this integration operation")
    if (!context.workspacePath) throw new PluginDataError("RESOURCE_REQUIRED", "Select a workspace before using this integration")
    const integrationContext = { workspacePath: context.workspacePath, signal: context.signal, authorize: async () => {
      context.check()
      if (this.safeMode) throw new PluginDataError("STALE_ACTIVATION", "Plugin execution is disabled on this host")
      if (await realpath(context.workspacePath!) !== context.workspacePath) throw new PluginDataError("STALE_ACTIVATION", "The selected workspace is unavailable")
      context.check()
    } }
    return this.provider(context, async () => {
      context.check()
      if (executor) return executor(request, integrationContext)
      switch (request.integration) {
        case "github": return executeGitHubIntegration(request, integrationContext)
        case "vercel": return executeVercelIntegration(request, integrationContext)
        case "cloudflare": return executeCloudflareIntegration(request, integrationContext)
      }
    })
  }

  async runLegacyIntegration(req: IncomingMessage, input: { pluginId: string; projectPath: string; signal?: AbortSignal }, request: PluginIntegrationRequest, executor?: PluginIntegrationExecutor): Promise<unknown> {
    return this.withLegacyPlugin(req, input, async caller => {
      const binding = this.authorization.resolve(caller.request)
      const snapshot = this.snapshot(), plugin = snapshot.plugins.find(value => value.id === input.pluginId)!
      const workspacePath = await this.projects.resolveWorkspace(caller.projectId, caller.projectPath)
      const lease = this.leases.create(binding, { pluginId: input.pluginId, digest: plugin.selectedDigest, projectKey: caller.projectId, workspacePath, contextEpoch: "legacy", grantsRevision: snapshot.revision, connectionRevision: this.connectionRevision })
      const context = await this.context(caller.request, { pluginId: input.pluginId, projectId: caller.projectId }, caller.options, lease)
      try { return await this.integration(context, request, executor) }
      finally { context.dispose() }
    })
  }

  async resolveSession(req: IncomingMessage, leaseId: string, handle: string, signal?: AbortSignal) {
    const lease = this.resolveLease(req, leaseId)
    const context = await this.context(req, { pluginId: lease.pluginId, projectId: lease.projectKey }, { authorize: () => { this.resolveLease(req, leaseId) }, signal }, lease)
    try {
      if (!context.plugin.manifest.permissions.navigation.includes("session")) throw new PluginDataError("PERMISSION_REQUIRED", "Session navigation has not been granted")
      return await this.sessionNavigation.resolve(lease, handle, context.guard)
    } finally { context.dispose() }
  }

  async presentSession(req: IncomingMessage, leaseId: string, address: { dirName: string; fileName: string }, signal?: AbortSignal): Promise<{ handle: string }> {
    const lease = this.resolveLease(req, leaseId)
    const context = await this.context(req, { pluginId: lease.pluginId, projectId: lease.projectKey }, { authorize: () => { this.resolveLease(req, leaseId) }, signal }, lease)
    try {
      if (!context.plugin.manifest.permissions.context.includes("session.identity")) throw new PluginDataError("PERMISSION_REQUIRED", "Session identity has not been granted")
      return await this.sessionNavigation.presentCurrent(lease, address, context.guard)
    } finally { context.dispose() }
  }

  async call(req: IncomingMessage, leaseId: string, request: PluginRequest, options: { signal?: AbortSignal } = {}): Promise<JsonValue> {
    const lease = this.resolveLease(req, leaseId)
    options.signal?.throwIfAborted()
    if (request.method === "lifecycle.ready") return null
    const context = await this.context(req, { pluginId: lease.pluginId, projectId: lease.projectKey }, { authorize: () => { this.resolveLease(req, leaseId) }, signal: options.signal }, lease)
    try {
      if (request.method === "navigation.openSession") {
        await this.resolveSession(req, leaseId, request.params.handle, context.signal)
        return null
      }
      if (request.method === "integrations.request") {
        try {
          const data = await this.integration(context, request.params)
          return parseMethodResult("integrations.request", { ok: true, data: request.params.operation === "pullSessions" ? this.sessionNavigation.present(lease, data as GitHubPullSessionsResponse) : data })
        } catch (error) {
          await context.guard()
          if (error instanceof GitHubRouteError || error instanceof VercelDeploymentsRouteError || error instanceof CloudflareRouteError) return parseJson({ ok: false, error: { code: error.code, message: error.message.slice(0, 512) } })
          throw error
        }
      }
      if (request.method === "composer.append" && context.plugin.manifest.permissions.composer.includes("append")) return null
      if (request.method === "navigation.openExternal" && context.plugin.manifest.permissions.navigation.includes("external")) return null
      if (request.method === "connections.request" || request.method === "connections.status") {
        const connection = this.connection(context, request.params.handle)
        if (request.method === "connections.status") return parseJson({ configured: !!connection.connection.secret, readOnly: !!connection.environment, selected: connection.connection.selected })
        if (!connection.connection.secret) throw new PluginDataError("CONNECTION_REQUIRED", "Configure this connection in host settings")
        const value = await this.provider(context, async () => result(await (await this.executor(context, connection)).request({ operation: request.params.operationId, args: request.params.args })))
        await context.guard()
        return value
      }
      const storage = context.plugin.manifest.permissions.storage
      if (storage && (request.method === "storage.get" || request.method === "storage.set" || request.method === "storage.delete")) {
        if (storage.scope === "project" && !lease.projectKey) throw new PluginDataError("RESOURCE_REQUIRED", "Select a project before using plugin storage")
        const scope = { ...context.scope, projectKey: storage.scope === "project" ? lease.projectKey : null, stateVersion: context.plugin.manifest.stateVersion, quotaKiB: storage.quotaKiB }
        if (request.method === "storage.get") return this.state!.get(scope, request.params.key)
        await this.state!.write(scope, request.params.key, request.method === "storage.set" ? request.params.value : undefined, context.guard)
        await context.guard()
        return null
      }
      throw new PluginAuthorizationError(403, "PERMISSION_REQUIRED", "This host does not provide the requested plugin capability")
    } finally { context.dispose() }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.leases.dispose()
    this.authorization.dispose()
    await this.connections?.close()
    await this.state?.close()
    await this.storeValue?.close()
  }
}

let currentManager: PluginManager | null = null
export async function initializePluginManager(dataRoot: string, options: PluginManagerOptions = {}): Promise<PluginManager> {
  const manager = new PluginManager(join(dataRoot, "runtime-plugins"), options)
  await manager.initialize()
  currentManager = manager
  return manager
}
export function getPluginManager(): PluginManager | null { return currentManager }
