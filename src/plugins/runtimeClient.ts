import { z } from "zod"
import { PLUGIN_API_VERSION, PROTOCOL_MAJOR, RUNTIME, parseMethodResult, type ClientRuntimeDescriptor, type PluginRequest } from "@cogpit/plugin-contracts"
import { pluginHostStatusSchema, pluginPreviewSchema, pluginSnapshotSchema, pluginProjectSchema, type PluginHostStatus, type PluginProjectSummary } from "../../shared/contracts/pluginManagement"
import { pluginConnectionSnapshotSchema, pluginResourceOptionsSchema, type PluginConnectionTarget } from "../../shared/contracts/pluginConnections"
import type { PluginInstallPreview, PluginScope } from "../../shared/contracts/plugins"
import { authFetch } from "@/lib/auth"
import { getActiveDeviceScope, getActiveIdentity, withBase } from "@/lib/device"
import { version } from "../../package.json"
import { getPluginBrowserSupport } from "./browserSupport"

const sessionSchema = z.strictObject({ sessionId: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive() })
const leaseSchema = z.strictObject({ id: z.string().min(1).max(128), expiresAt: z.number().int().positive() })
const trialSchema = z.strictObject({ deadline: z.number().int().positive() })
const outcomeSchema = z.strictObject({ status: z.enum(["prepared", "trial", "committing", "committed", "cancelled", "abandoned"]), preview: pluginPreviewSchema, deadline: z.number().int().positive().optional() })
export type RuntimeLease = z.infer<typeof leaseSchema>
export interface RuntimePluginState { status: PluginHostStatus | null; error: string | null; activation: string }
export const EMPTY_PLUGIN_STATE: RuntimePluginState = { status: null, error: null, activation: "" }

export function clientRuntimeDescriptor(): ClientRuntimeDescriptor {
  const support = getPluginBrowserSupport()
  return {
    appVersion: version, apiVersions: [PLUGIN_API_VERSION], manifestVersions: [1], protocolVersions: [PROTOCOL_MAJOR],
    runtimes: support.supported ? [RUNTIME] : [],
    capabilities: support.supported ? { "workspace.panel": "1.0.0", "composer.append": "1.0.0", "navigation.external": "1.0.0", "navigation.session": "1.0.0" } : {},
    browser: support.browser,
  }
}

export class PluginRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message) }
}

async function boundedBytes(response: Response, limit: number): Promise<ArrayBuffer> {
  const length = response.headers.get("Content-Length")
  if (length && Number(length) > limit) { await response.body?.cancel(); throw new Error("Plugin response exceeds its size limit") }
  if (!response.body) throw new Error("Plugin host returned an empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error("Plugin response exceeds its size limit")
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes.buffer
}

async function readResponse(response: Response): Promise<unknown> {
  const bytes = await boundedBytes(response, 4 * 1024 * 1024)
  let value: unknown
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch { throw new Error("This host does not support runtime plugins, or returned an invalid response") }
  if (!response.ok) {
    const parsed = z.object({ error: z.string().max(2000), code: z.string().max(128).optional() }).safeParse(value)
    throw new PluginRequestError(parsed.success ? parsed.data.error : "Plugin request failed", parsed.success ? parsed.data.code ?? "HOST_ERROR" : "HOST_ERROR", response.status)
  }
  return value
}

export class RuntimePluginClient {
  readonly scope = getActiveDeviceScope()
  readonly identity = getActiveIdentity()
  readonly base = new URL(withBase("/api/plugins/"), window.location.origin)
  private lifetimeController: AbortController | undefined
  private get controller(): AbortController {
    const support = getPluginBrowserSupport()
    if (!support.supported) throw new PluginRequestError(support.error!, "UNSUPPORTED_BROWSER", 0)
    if (!this.lifetimeController) throw new Error("The plugin client has not started")
    return this.lifetimeController
  }
  private session: z.infer<typeof sessionSchema> | null = null
  private renewal: Promise<void> | null = null
  private refreshPromise: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private listeners = new Set<() => void>()
  private state = EMPTY_PLUGIN_STATE
  private running = false

  getSnapshot = (): RuntimePluginState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(state: RuntimePluginState): void {
    if (JSON.stringify(this.state) === JSON.stringify(state)) return
    this.state = state
    for (const listener of this.listeners) listener()
  }
  private assertCurrent(signal?: AbortSignal): void {
    const current = this.controller.signal
    const owner = signal ?? current
    owner.throwIfAborted()
    if (!this.running || this.scope !== getActiveDeviceScope() || this.identity !== getActiveIdentity()) throw new Error("The connected host or signed-in user changed")
  }
  private hostChanged = (): void => {
    if (this.scope !== getActiveDeviceScope() || this.identity !== getActiveIdentity()) this.stop()
  }
  start(): void {
    if (this.running) return
    const support = getPluginBrowserSupport()
    if (!support.supported) { this.publish({ status: null, error: support.error, activation: "" }); return }
    this.running = true
    this.lifetimeController = new AbortController()
    for (const event of ["cogpit-device-changed", "cogpit-device-scope-changed", "cogpit-identity-changed", "popstate"]) window.addEventListener(event, this.hostChanged)
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, 5000)
  }
  stop(): void {
    this.running = false
    clearInterval(this.timer)
    this.lifetimeController?.abort()
    const session = this.session
    this.session = null
    this.renewal = null
    this.refreshPromise = null
    for (const event of ["cogpit-device-changed", "cogpit-device-scope-changed", "cogpit-identity-changed", "popstate"]) window.removeEventListener(event, this.hostChanged)
    this.publish(EMPTY_PLUGIN_STATE)
    if (session) this.releaseSession(session.sessionId)
  }
  private releaseSession(sessionId: string): void {
    if (!getPluginBrowserSupport().supported) return
    void authFetch(new URL("session", this.base), { method: "DELETE", headers: { "X-Cogpit-Plugin-Session": sessionId }, signal: AbortSignal.timeout(5000), keepalive: true }).catch(() => {})
  }
  private async ensureSession(): Promise<void> {
    this.assertCurrent()
    if (this.session && this.session.expiresAt - Date.now() > 25_000) return
    if (this.renewal) return this.renewal
    const signal = this.controller.signal
    const headers = new Headers()
    headers.set("Content-Type", "application/json")
    if (this.session) headers.set("X-Cogpit-Plugin-Session", this.session.sessionId)
    const renewal = (async () => {
      const response = await authFetch(new URL("session", this.base), { method: "POST", headers, body: JSON.stringify({ client: clientRuntimeDescriptor() }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
      const session = sessionSchema.parse(await readResponse(response))
      try { this.assertCurrent(signal) }
      catch (error) { this.releaseSession(session.sessionId); throw error }
      this.session = session
    })()
    this.renewal = renewal
    try { await renewal }
    finally { if (this.renewal === renewal) this.renewal = null }
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = this.controller.signal
    await this.ensureSession()
    this.assertCurrent(signal)
    const headers = new Headers(init.headers)
    headers.set("X-Cogpit-Plugin-Session", this.session!.sessionId)
    const response = await authFetch(new URL(path, this.base), { ...init, headers, signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) })
    this.assertCurrent(signal)
    return response
  }
  private async json(path: string, body?: unknown, method = "POST", signal?: AbortSignal): Promise<unknown> {
    const owner = this.controller.signal
    const response = await this.request(path, { method, signal, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) })
    const result = await readResponse(response)
    this.assertCurrent(owner)
    return result
  }
  refresh(): Promise<void> {
    const support = getPluginBrowserSupport()
    if (!support.supported) {
      this.stop()
      this.publish({ status: null, error: support.error, activation: "" })
      return Promise.resolve()
    }
    if (this.refreshPromise) return this.refreshPromise
    const signal = this.controller.signal
    const refresh = (async () => {
      try {
        const status = pluginHostStatusSchema.parse(await this.json("status", undefined, "GET"))
        this.assertCurrent(signal)
        if (this.state.status?.host.instanceId === status.host.instanceId && this.state.status.store.revision > status.store.revision) return
        this.publish({ status, error: null, activation: `${this.scope}:${this.identity ?? "personal"}:${status.host.instanceId}:${this.session!.sessionId}:${status.connectionRevision ?? 0}` })
      } catch (error) {
        if (signal.aborted || !this.running) return
        if (error instanceof PluginRequestError && error.code === "STALE_ACTIVATION") this.session = null
        this.publish({ status: null, error: error instanceof Error ? error.message : "Plugin host is unavailable", activation: "" })
      }
    })()
    this.refreshPromise = refresh
    void refresh.finally(() => { if (this.refreshPromise === refresh) this.refreshPromise = null })
    return refresh
  }
  async stageSeed(pluginId: string, scope: PluginScope): Promise<PluginInstallPreview> {
    return pluginPreviewSchema.parse(await this.json("stage-seed", { pluginId, scope, client: clientRuntimeDescriptor() }))
  }
  async stage(file: Blob, scope: PluginScope): Promise<PluginInstallPreview> {
    const signal = this.controller.signal
    if (file.size > 4 * 1024 * 1024) throw new Error("Choose a plugin package smaller than 4 MiB")
    const preview = pluginPreviewSchema.parse(await readResponse(await this.request("stage", { method: "POST", body: file, headers: {
      "Content-Type": "application/octet-stream", "X-Cogpit-Plugin-Client": JSON.stringify(clientRuntimeDescriptor()), "X-Cogpit-Plugin-Scope": JSON.stringify(scope),
    } })))
    this.assertCurrent(signal)
    return preview
  }
  async payload(reference: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const owner = this.controller.signal
    const response = await this.request(`payload/${encodeURIComponent(reference)}`, { signal })
    if (!response.ok) await readResponse(response)
    const bytes = await boundedBytes(response, 4 * 1024 * 1024)
    this.assertCurrent(owner)
    signal?.throwIfAborted()
    return bytes
  }
  private acceptStore(value: unknown): void {
    const store = pluginSnapshotSchema.parse(value)
    const status = this.state.status
    if (status && store.revision >= status.store.revision) this.publish({ ...this.state, status: { ...status, store, runtime: { ...status.runtime, registryRevision: store.revision } } })
  }
  async beginTrial(preview: PluginInstallPreview, signal?: AbortSignal): Promise<number> { return trialSchema.parse(await this.json(`transactions/${preview.transactionId}/trial`, undefined, "POST", signal)).deadline }
  async commit(preview: PluginInstallPreview, signal?: AbortSignal): Promise<void> {
    this.acceptStore(await this.json(`transactions/${preview.transactionId}/commit`, { expectedRevision: preview.registryRevision }, "POST", signal))
    await this.refresh()
  }
  async transactionOutcome(preview: PluginInstallPreview) {
    return outcomeSchema.parse(await this.json(`transactions/${preview.transactionId}`, undefined, "GET"))
  }
  async cancel(preview: PluginInstallPreview): Promise<void> { await this.json(`transactions/${preview.transactionId}`, undefined, "DELETE") }
  async enrollDeveloper(input: { publisher: string; label: string; root: string; fingerprint: string }): Promise<void> {
    this.acceptStore(await this.json("publishers", { ...input, development: true }))
    await this.refresh()
  }
  async changeInstalled(id: string, action: "enabled" | "scope" | "pin" | "uninstall", values: Record<string, unknown>, expectedRevision: number): Promise<void> {
    const path = `installed/${encodeURIComponent(id)}${action === "uninstall" ? "" : `/${action}`}`
    this.acceptStore(await this.json(path, { ...values, expectedRevision }, action === "uninstall" ? "DELETE" : "POST"))
    await this.refresh()
  }
  async rollback(id: string, digest: string, scope: PluginScope): Promise<PluginInstallPreview> {
    return pluginPreviewSchema.parse(await this.json(`installed/${encodeURIComponent(id)}/rollback`, { digest, scope, client: clientRuntimeDescriptor() }))
  }
  async lease(pluginId: string, projectId: string | null, contextEpoch: string, signal: AbortSignal, workspacePath?: string | null): Promise<RuntimeLease> {
    return leaseSchema.parse(await this.json("leases", { pluginId, projectId, contextEpoch, ...(workspacePath ? { workspacePath } : {}), client: clientRuntimeDescriptor() }, "POST", signal))
  }
  async renewLease(id: string, signal: AbortSignal): Promise<RuntimeLease> { return leaseSchema.parse(await this.json(`leases/${encodeURIComponent(id)}/renew`, undefined, "POST", signal)) }
  async revokeLease(id: string): Promise<void> { await this.json(`leases/${encodeURIComponent(id)}`, undefined, "DELETE") }
  async call(id: string, request: PluginRequest, signal: AbortSignal) {
    const response = z.strictObject({ value: z.unknown() }).parse(await this.json(`leases/${encodeURIComponent(id)}/call`, request, "POST", signal))
    return parseMethodResult(request.method, response.value)
  }
  async resolveSession(id: string, handle: string, signal: AbortSignal): Promise<{ dirName: string; fileName: string }> {
    return z.strictObject({ dirName: z.string().min(1).max(8192), fileName: z.string().min(1).max(8192) }).parse(await this.json(`leases/${encodeURIComponent(id)}/session`, { handle }, "POST", signal))
  }
  async resolveWorkspace(workspacePath: string, signal: AbortSignal): Promise<PluginProjectSummary | null> {
    return pluginProjectSchema.nullable().parse(await this.json("workspace/resolve", { workspacePath }, "POST", signal))
  }
  async connections(target: PluginConnectionTarget, signal?: AbortSignal) {
    const query = new URLSearchParams({ pluginId: target.pluginId, ...(target.projectId ? { projectId: target.projectId } : {}) })
    return pluginConnectionSnapshotSchema.parse(await this.json(`connections?${query}`, undefined, "GET", signal))
  }
  async connectionOptions(target: PluginConnectionTarget, connectionId: string, resourceId: string, signal?: AbortSignal) {
    return pluginResourceOptionsSchema.parse(await this.json("connections/options", { ...target, connectionId, resourceId }, "POST", signal))
  }
  async changeConnection(target: PluginConnectionTarget, connectionId: string, action: "credential" | "select" | "disconnect" | "import-legacy", values: Record<string, unknown>, expectedRevision: number, signal?: AbortSignal) {
    const result = pluginConnectionSnapshotSchema.parse(await this.json(`connections/${action}`, { ...target, connectionId, ...values, expectedRevision }, "POST", signal))
    await this.refresh()
    return result
  }
  async clearPluginData(pluginId: string, expectedRevision: number, signal?: AbortSignal): Promise<void> {
    await this.json("connections/clear-data", { pluginId, expectedRevision }, "POST", signal)
    await this.refresh()
  }
}
