import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react"
import type { VercelIntegrationRequest } from "@cogpit/plugin-contracts"
import type { VercelBuildLogsResponse, VercelDeploymentsErrorResponse, VercelDeploymentsResponse } from "@cogpit/plugin-integrations"

export interface VercelDeploymentsState {
  data: VercelDeploymentsResponse | null
  error: VercelDeploymentsErrorResponse | null
  loading: boolean
  refreshing: boolean
}
interface StoreEntry {
  snapshot: VercelDeploymentsState
  listeners: Set<() => void>
  request: Promise<void> | null
  fetchedAt: number
}
export type VercelRequest = (projectKey: string, input: VercelIntegrationRequest, signal: AbortSignal) => Promise<VercelDeploymentsResponse | VercelBuildLogsResponse>
const EMPTY_STATE: VercelDeploymentsState = { data: null, error: null, loading: false, refreshing: false }
const CACHE_WINDOW_MS = 8_000
const POLL_INTERVAL_MS = 10_000
const SETUP_ERROR_CODES = new Set<VercelDeploymentsErrorResponse["code"]>(["vercel_access_denied", "vercel_auth_required", "vercel_cli_too_old", "vercel_missing"])

export function createVercelDeploymentsStore(request: VercelRequest) {
  const stores = new Map<string, StoreEntry>()
  const lifetime = new AbortController()
  function storeFor(projectKey: string): StoreEntry {
    let store = stores.get(projectKey)
    if (!store) { store = { snapshot: EMPTY_STATE, listeners: new Set(), request: null, fetchedAt: 0 }; stores.set(projectKey, store) }
    return store
  }
  function publish(store: StoreEntry, snapshot: VercelDeploymentsState): void {
    if (lifetime.signal.aborted) return
    store.snapshot = snapshot
    for (const listener of store.listeners) listener()
  }
  async function load(projectKey: string, force = false): Promise<void> {
    if (lifetime.signal.aborted) return
    const store = storeFor(projectKey)
    if (store.request) return store.request
    if (!force && store.snapshot.error && SETUP_ERROR_CODES.has(store.snapshot.error.code)) return
    if (!force && store.fetchedAt > 0 && Date.now() - store.fetchedAt < CACHE_WINDOW_MS) return
    const retainedError = force ? null : store.snapshot.error
    publish(store, { ...store.snapshot, error: retainedError, loading: store.snapshot.data === null && retainedError === null, refreshing: store.snapshot.data !== null })
    const pending = Promise.resolve().then(() => {
      lifetime.signal.throwIfAborted()
      return request(projectKey, { integration: "vercel", operation: "deployments", limit: 20 }, lifetime.signal)
    }).then(data => {
      if (!("deployments" in data) || !Array.isArray(data.deployments)) throw { code: "invalid_response", error: "Vercel returned an invalid deployments response" }
      lifetime.signal.throwIfAborted()
      store.fetchedAt = Date.now()
      publish(store, { data, error: null, loading: false, refreshing: false })
    }).catch((error: unknown) => {
      store.fetchedAt = Date.now()
      const detail = error && typeof error === "object" ? error as Partial<VercelDeploymentsErrorResponse> : {}
      publish(store, { ...store.snapshot, error: { error: typeof detail.error === "string" ? detail.error : "Unable to load Vercel deployments", code: typeof detail.code === "string" ? detail.code as VercelDeploymentsErrorResponse["code"] : "vercel_api_failed" }, loading: false, refreshing: false })
    }).finally(() => { if (store.request === pending) store.request = null })
    store.request = pending
    return pending
  }
  return {
    load,
    subscribe(projectKey: string, listener: () => void): () => void {
      if (!projectKey || lifetime.signal.aborted) return () => {}
      const store = storeFor(projectKey); store.listeners.add(listener)
      return () => { store.listeners.delete(listener) }
    },
    snapshot(projectKey: string): VercelDeploymentsState { return projectKey ? storeFor(projectKey).snapshot : EMPTY_STATE },
    async fetchBuildLogs(projectKey: string, deploymentId: string, callerSignal?: AbortSignal): Promise<VercelBuildLogsResponse> {
      const signal = callerSignal ? AbortSignal.any([lifetime.signal, callerSignal]) : lifetime.signal
      signal.throwIfAborted()
      const data = await request(projectKey, { integration: "vercel", operation: "buildLogs", deploymentId, limit: 200 }, signal)
      signal.throwIfAborted()
      if (!("events" in data) || !Array.isArray(data.events) || data.deploymentId !== deploymentId) throw { code: "invalid_response", error: "Vercel returned an invalid build log response" }
      return data
    },
    dispose() { lifetime.abort(); for (const store of stores.values()) store.listeners.clear(); stores.clear() },
  }
}
export type VercelDeploymentsStore = ReturnType<typeof createVercelDeploymentsStore>
const StoreContext = createContext<VercelDeploymentsStore | null>(null)
export const VercelDeploymentsProvider = StoreContext.Provider
export function useVercelDeployments(projectPath: string | null, enabled: boolean) {
  const store = useContext(StoreContext)
  if (!store) throw new Error("Vercel deployments store is unavailable")
  const path = projectPath ?? ""
  const state = useSyncExternalStore(useCallback(listener => store.subscribe(path, listener), [store, path]), useCallback(() => store.snapshot(path), [store, path]), () => EMPTY_STATE)
  useEffect(() => {
    if (!enabled || !path) return
    void store.load(path)
    const interval = window.setInterval(() => { void store.load(path) }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [store, enabled, path])
  const refresh = useCallback(() => path ? store.load(path, true) : Promise.resolve(), [store, path])
  const fetchBuildLogs = useCallback((deploymentId: string, signal?: AbortSignal) => store.fetchBuildLogs(path, deploymentId, signal), [store, path])
  return { ...state, refresh, fetchBuildLogs }
}
