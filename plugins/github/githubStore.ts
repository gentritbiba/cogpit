import { createContext, useContext, useCallback, useEffect, useSyncExternalStore } from "react"
import type {
  GitHubActionsJobsResponse,
  GitHubActionsRunsResponse,
  GitHubErrorResponse,
  GitHubIssuesResponse,
  GitHubPullFilesResponse,
  GitHubPullSessionsResponse,
  GitHubPullsResponse,
} from "@cogpit/plugin-integrations"
import type { PluginClient } from "@cogpit/plugin-sdk"
import type { GitHubIntegrationRequest } from "@cogpit/plugin-contracts"

export interface GitHubResourceState<T> {
  data: T | null
  error: GitHubErrorResponse | null
  loading: boolean
  refreshing: boolean
}

interface StoreEntry<T> {
  snapshot: GitHubResourceState<T>
  listeners: Set<() => void>
  request: Promise<void> | null
  fetchedAt: number
  settleTimer: number | null
  settleAttempts: number
  active: number
}

interface ResourceDefinition<T> {
  input: GitHubIntegrationRequest
  client: Pick<PluginClient, "integrations">
  signal: AbortSignal
  pollIntervalMs: number
  fallbackError: string
  stores: Map<string, StoreEntry<T>>
  /** Fetch again soon when the server answered with a still-settling result. */
  settling?: (data: T) => boolean
}

const EMPTY_STATE: GitHubResourceState<never> = {
  data: null,
  error: null,
  loading: false,
  refreshing: false,
}
const CACHE_WINDOW_MS = 8_000
const SETTLE_RETRY_MS = 1_500
/** Bounds the settle poll so a permanently-pending server cannot loop forever. */
const SETTLE_MAX_ATTEMPTS = 10
const SETUP_ERROR_CODES = new Set<GitHubErrorResponse["code"]>([
  "gh_missing",
  "gh_auth_required",
  "no_git_repository",
  "no_github_remote",
])

export function createGitHubStore(client: Pick<PluginClient, "integrations">) {
  const controller = new AbortController()
  const resource = <T>(input: GitHubIntegrationRequest, pollIntervalMs: number, fallbackError: string, settling?: (data: T) => boolean): ResourceDefinition<T> => ({ input, pollIntervalMs, fallbackError, stores: new Map(), client, signal: controller.signal, settling })
  const actions = resource<GitHubActionsRunsResponse>({ integration: "github", operation: "actions", limit: 20 }, 10000, "Unable to load GitHub Actions")
  const pulls = resource<GitHubPullsResponse>({ integration: "github", operation: "pulls", limit: 30 }, 30000, "Unable to load pull requests")
  const issues = resource<GitHubIssuesResponse>({ integration: "github", operation: "issues", limit: 30 }, 60000, "Unable to load issues")
  const pullSessions = resource<GitHubPullSessionsResponse>({ integration: "github", operation: "pullSessions" }, 30000, "Unable to match sessions to pull requests", data => data.pending > 0)
  return {
    actions, pulls, issues, pullSessions,
    details: {
      actionsJobs: (_projectKey: string, runId: number) => request<GitHubActionsJobsResponse>(client, { integration: "github", operation: "actionJobs", runId }, controller.signal),
      pullFiles: (_projectKey: string, number: number) => request<GitHubPullFilesResponse>(client, { integration: "github", operation: "pullFiles", number }, controller.signal),
    },
    dispose() {
      controller.abort()
      for (const resource of [actions, pulls, issues, pullSessions]) {
        for (const store of resource.stores.values()) { if (store.settleTimer !== null) window.clearTimeout(store.settleTimer); store.listeners.clear() }
        resource.stores.clear()
      }
    },
  }
}
export type GitHubStore = ReturnType<typeof createGitHubStore>
const StoreContext = createContext<GitHubStore | null>(null)
export const GitHubStoreProvider = StoreContext.Provider
function useStore(): GitHubStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error("GitHub requires its runtime store")
  return store
}
export function useGitHubDetails() { return useStore().details }
async function request<T>(client: Pick<PluginClient, "integrations">, input: GitHubIntegrationRequest, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const result = await client.integrations.request(input, { signal })
  signal.throwIfAborted()
  if (!result.ok) throw { code: result.error.code, error: result.error.message }
  return result.data as unknown as T
}

function storeFor<T>(resource: ResourceDefinition<T>, projectKey: string): StoreEntry<T> {
  let store = resource.stores.get(projectKey)
  if (!store) {
    store = {
      snapshot: EMPTY_STATE,
      listeners: new Set(),
      request: null,
      fetchedAt: 0,
      settleTimer: null,
      settleAttempts: 0,
      active: 0,
    }
    resource.stores.set(projectKey, store)
  }
  return store
}

function publish<T>(store: StoreEntry<T>, snapshot: GitHubResourceState<T>): void {
  store.snapshot = snapshot
  for (const listener of store.listeners) listener()
}

export function toErrorResponse(error: unknown, fallback: string): GitHubErrorResponse {
  const detail = error as Partial<GitHubErrorResponse>
  return {
    error: typeof detail.error === "string" ? detail.error : fallback,
    code: typeof detail.code === "string" ? detail.code as GitHubErrorResponse["code"] : "github_api_failed",
  }
}

async function load<T>(resource: ResourceDefinition<T>, projectKey: string, force = false): Promise<void> {
  if (resource.signal.aborted) return
  const store = storeFor(resource, projectKey)
  if (store.request) return store.request
  if (!force && store.snapshot.error && SETUP_ERROR_CODES.has(store.snapshot.error.code)) return
  if (!force && store.fetchedAt > 0 && Date.now() - store.fetchedAt < CACHE_WINDOW_MS) return

  // A background poll must stay invisible: showing `refreshing` would flicker
  // the refresh button on every interval, and clearing `error` would cycle a
  // standing failure between its alert and a skeleton.
  if (force || store.snapshot.data === null) {
    publish(store, {
      ...store.snapshot,
      error: force ? null : store.snapshot.error,
      loading: store.snapshot.data === null,
      refreshing: store.snapshot.data !== null,
    })
  }

  store.request = request<T>(resource.client, resource.input, resource.signal)
    .then((data) => {
      if (resource.signal.aborted) return
      store.fetchedAt = Date.now()
      publish(store, { data, error: null, loading: false, refreshing: false })
      if (resource.settling?.(data) && store.active > 0 && store.settleAttempts < SETTLE_MAX_ATTEMPTS) {
        store.settleAttempts += 1
        store.settleTimer = window.setTimeout(() => {
          store.settleTimer = null
          if (store.active > 0 && document.visibilityState !== "hidden") void load(resource, projectKey, true)
        }, SETTLE_RETRY_MS)
      } else {
        store.settleAttempts = 0
      }
    })
    .catch((error: unknown) => {
      if (resource.signal.aborted) return
      publish(store, {
        ...store.snapshot,
        error: toErrorResponse(error, resource.fallbackError),
        loading: false,
        refreshing: false,
      })
    })
    .finally(() => {
      store.request = null
    })

  return store.request
}

function useGitHubResource<T>(resource: ResourceDefinition<T>, projectKey: string | null, enabled: boolean) {
  const path = projectKey ?? ""
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => {
      if (!path) return () => undefined
      const store = storeFor(resource, path)
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }, [resource, path]),
    useCallback(
      (): GitHubResourceState<T> => path ? storeFor(resource, path).snapshot : EMPTY_STATE,
      [resource, path],
    ),
    (): GitHubResourceState<T> => EMPTY_STATE,
  )

  useEffect(() => {
    if (!enabled || !path) return
    const store = storeFor(resource, path)
    store.active++
    void load(resource, path)
    const interval = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(resource, path) }, resource.pollIntervalMs)
    return () => {
      window.clearInterval(interval)
      store.active--
      if (store.active === 0 && store.settleTimer !== null) { window.clearTimeout(store.settleTimer); store.settleTimer = null }
    }
  }, [resource, enabled, path])

  const refresh = useCallback(() => path ? load(resource, path, true) : Promise.resolve(), [resource, path])
  return { ...state, refresh }
}

export function useGitHubActions(projectKey: string | null, enabled: boolean) {
  return useGitHubResource(useStore().actions, projectKey, enabled)
}

export function useGitHubPulls(projectKey: string | null, enabled: boolean) {
  return useGitHubResource(useStore().pulls, projectKey, enabled)
}

export function useGitHubIssues(projectKey: string | null, enabled: boolean) {
  return useGitHubResource(useStore().issues, projectKey, enabled)
}

export function useGitHubPullSessions(projectKey: string | null, enabled: boolean) {
  return useGitHubResource(useStore().pullSessions, projectKey, enabled)
}
