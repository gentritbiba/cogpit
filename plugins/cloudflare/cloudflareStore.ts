import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react"
import type { CloudflareIntegrationRequest } from "@cogpit/plugin-contracts"
import type { CloudflareDeploymentsResponse, CloudflareErrorResponse, CloudflareVersionResponse, CloudflareWorkspace } from "@cogpit/plugin-integrations"

export interface CloudflareState {
  workspace: CloudflareWorkspace | null
  deployments: CloudflareDeploymentsResponse | null
  error: CloudflareErrorResponse | null
  loading: boolean
  refreshing: boolean
}
interface StoreEntry {
  snapshot: CloudflareState
  listeners: Set<() => void>
  request: Promise<void> | null
  fetchedAt: number
}
export type CloudflareResponse = CloudflareWorkspace | CloudflareDeploymentsResponse | CloudflareVersionResponse
export type CloudflareRequest = (projectKey: string, input: CloudflareIntegrationRequest, signal: AbortSignal) => Promise<CloudflareResponse>
const EMPTY_STATE: CloudflareState = { workspace: null, deployments: null, error: null, loading: false, refreshing: false }
const CACHE_WINDOW_MS = 8_000
/** Wrangler spawns a Node process per read, so poll less eagerly than API-backed panels. */
const POLL_INTERVAL_MS = 30_000
/** Errors the user must fix on the host before another read can succeed; they are retried only by an explicit refresh. */
const SETUP_ERROR_CODES = new Set<CloudflareErrorResponse["code"]>(["cloudflare_access_denied", "cloudflare_account_required", "cloudflare_auth_required", "cloudflare_pages_unsupported", "wrangler_missing", "wrangler_too_old"])

function failure(error: unknown, fallback: string): CloudflareErrorResponse {
  const detail = error && typeof error === "object" ? error as Partial<CloudflareErrorResponse> : {}
  return { error: typeof detail.error === "string" ? detail.error : fallback, code: typeof detail.code === "string" ? detail.code as CloudflareErrorResponse["code"] : "cloudflare_api_failed" }
}
const entryKey = (projectKey: string, config: string | null, environment: string | null) => `${projectKey}\n${config ?? ""}\n${environment ?? ""}`
const workspaceKey = (projectKey: string, config: string | null) => `${projectKey}\n${config ?? ""}`
const configArgs = (config: string | null) => config ? { config } : {}

export function createCloudflareStore(request: CloudflareRequest) {
  const entries = new Map<string, StoreEntry>()
  const workspaces = new Map<string, CloudflareWorkspace>()
  const lifetime = new AbortController()
  function entryFor(projectKey: string, config: string | null, environment: string | null): StoreEntry {
    const key = entryKey(projectKey, config, environment)
    let entry = entries.get(key)
    if (!entry) { entry = { snapshot: EMPTY_STATE, listeners: new Set(), request: null, fetchedAt: 0 }; entries.set(key, entry) }
    return entry
  }
  function publish(entry: StoreEntry, snapshot: CloudflareState): void {
    if (lifetime.signal.aborted) return
    entry.snapshot = snapshot
    for (const listener of entry.listeners) listener()
  }
  async function loadWorkspace(projectKey: string, config: string | null, force: boolean): Promise<CloudflareWorkspace> {
    const cached = force ? undefined : workspaces.get(workspaceKey(projectKey, config))
    if (cached) return cached
    const data = await request(projectKey, { integration: "cloudflare", operation: "workspace", ...configArgs(config) }, lifetime.signal)
    if (!("environments" in data) || !Array.isArray(data.environments)) throw { code: "invalid_response", error: "Wrangler returned an invalid workspace description" }
    workspaces.set(workspaceKey(projectKey, config), data)
    return data
  }
  async function load(projectKey: string, config: string | null, environment: string | null, force = false): Promise<void> {
    if (lifetime.signal.aborted) return
    const entry = entryFor(projectKey, config, environment)
    if (entry.request) return entry.request
    if (!force && entry.snapshot.error && SETUP_ERROR_CODES.has(entry.snapshot.error.code)) return
    if (!force && entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < CACHE_WINDOW_MS) return
    const retainedError = force ? null : entry.snapshot.error
    publish(entry, { ...entry.snapshot, error: retainedError, loading: entry.snapshot.deployments === null && retainedError === null, refreshing: entry.snapshot.deployments !== null })
    const pending = Promise.resolve().then(async () => {
      lifetime.signal.throwIfAborted()
      const workspace = await loadWorkspace(projectKey, config, force)
      lifetime.signal.throwIfAborted()
      const deployments = await request(projectKey, { integration: "cloudflare", operation: "deployments", limit: 20, ...configArgs(config), ...(environment ? { environment } : {}) }, lifetime.signal)
      if (!("deployments" in deployments) || !Array.isArray(deployments.deployments)) throw { code: "invalid_response", error: "Wrangler returned an invalid deployments list" }
      lifetime.signal.throwIfAborted()
      entry.fetchedAt = Date.now()
      publish(entry, { workspace, deployments, error: null, loading: false, refreshing: false })
    }).catch((error: unknown) => {
      entry.fetchedAt = Date.now()
      publish(entry, { ...entry.snapshot, workspace: workspaces.get(workspaceKey(projectKey, config)) ?? entry.snapshot.workspace, error: failure(error, "Unable to load Cloudflare deployments"), loading: false, refreshing: false })
    }).finally(() => { if (entry.request === pending) entry.request = null })
    entry.request = pending
    return pending
  }
  return {
    load,
    subscribe(projectKey: string, config: string | null, environment: string | null, listener: () => void): () => void {
      if (!projectKey || lifetime.signal.aborted) return () => {}
      const entry = entryFor(projectKey, config, environment); entry.listeners.add(listener)
      return () => { entry.listeners.delete(listener) }
    },
    snapshot(projectKey: string, config: string | null, environment: string | null): CloudflareState { return projectKey ? entryFor(projectKey, config, environment).snapshot : EMPTY_STATE },
    async fetchVersion(projectKey: string, config: string | null, environment: string | null, versionId: string, callerSignal?: AbortSignal): Promise<CloudflareVersionResponse> {
      const signal = callerSignal ? AbortSignal.any([lifetime.signal, callerSignal]) : lifetime.signal
      signal.throwIfAborted()
      const data = await request(projectKey, { integration: "cloudflare", operation: "version", versionId, ...configArgs(config), ...(environment ? { environment } : {}) }, signal)
      signal.throwIfAborted()
      if (!("version" in data) || data.version?.id !== versionId) throw { code: "invalid_response", error: "Wrangler returned an invalid version" }
      return data
    },
    dispose() { lifetime.abort(); for (const entry of entries.values()) entry.listeners.clear(); entries.clear(); workspaces.clear() },
  }
}
export type CloudflareStore = ReturnType<typeof createCloudflareStore>
const StoreContext = createContext<CloudflareStore | null>(null)
export const CloudflareProvider = StoreContext.Provider

export function useCloudflare(projectPath: string | null, config: string | null, environment: string | null, enabled: boolean) {
  const store = useContext(StoreContext)
  if (!store) throw new Error("Cloudflare store is unavailable")
  const path = projectPath ?? ""
  const state = useSyncExternalStore(
    useCallback(listener => store.subscribe(path, config, environment, listener), [store, path, config, environment]),
    useCallback(() => store.snapshot(path, config, environment), [store, path, config, environment]),
    () => EMPTY_STATE,
  )
  useEffect(() => {
    if (!enabled || !path) return
    void store.load(path, config, environment)
    const interval = window.setInterval(() => { void store.load(path, config, environment) }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [store, enabled, path, config, environment])
  const refresh = useCallback(() => path ? store.load(path, config, environment, true) : Promise.resolve(), [store, path, config, environment])
  const fetchVersion = useCallback((versionId: string, signal?: AbortSignal) => store.fetchVersion(path, config, environment, versionId, signal), [store, path, config, environment])
  return { ...state, refresh, fetchVersion }
}
