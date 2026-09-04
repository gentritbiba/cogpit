import { useCallback, useEffect, useSyncExternalStore } from "react"
import type {
  GitHubActionsJobsResponse,
  GitHubActionsRunsResponse,
  GitHubErrorResponse,
  GitHubIssuesResponse,
  GitHubPullFilesResponse,
  GitHubPullSessionsResponse,
  GitHubPullsResponse,
} from "../../shared/contracts/github"
import { authFetch } from "@/plugin-api"

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
}

interface ResourceDefinition<T> {
  endpoint: (projectPath: string) => string
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

const actions: ResourceDefinition<GitHubActionsRunsResponse> = {
  endpoint: (projectPath) => `/api/github/actions?cwd=${encodeURIComponent(projectPath)}&limit=20`,
  pollIntervalMs: 10_000,
  fallbackError: "Unable to load GitHub Actions",
  stores: new Map(),
}

const pulls: ResourceDefinition<GitHubPullsResponse> = {
  endpoint: (projectPath) => `/api/github/pulls?cwd=${encodeURIComponent(projectPath)}&limit=30`,
  pollIntervalMs: 30_000,
  fallbackError: "Unable to load pull requests",
  stores: new Map(),
}

const issues: ResourceDefinition<GitHubIssuesResponse> = {
  endpoint: (projectPath) => `/api/github/issues?cwd=${encodeURIComponent(projectPath)}&limit=30`,
  pollIntervalMs: 60_000,
  fallbackError: "Unable to load issues",
  stores: new Map(),
}

const pullSessions: ResourceDefinition<GitHubPullSessionsResponse> = {
  endpoint: (projectPath) => `/api/github/pulls/sessions?cwd=${encodeURIComponent(projectPath)}`,
  pollIntervalMs: 30_000,
  fallbackError: "Unable to match sessions to pull requests",
  stores: new Map(),
  settling: (data) => data.pending > 0,
}

function storeFor<T>(resource: ResourceDefinition<T>, projectPath: string): StoreEntry<T> {
  let store = resource.stores.get(projectPath)
  if (!store) {
    store = {
      snapshot: EMPTY_STATE,
      listeners: new Set(),
      request: null,
      fetchedAt: 0,
      settleTimer: null,
      settleAttempts: 0,
    }
    resource.stores.set(projectPath, store)
  }
  return store
}

function publish<T>(store: StoreEntry<T>, snapshot: GitHubResourceState<T>): void {
  store.snapshot = snapshot
  for (const listener of store.listeners) listener()
}

async function responseError(response: Response): Promise<GitHubErrorResponse> {
  try {
    const value = await response.json() as Partial<GitHubErrorResponse>
    if (typeof value.error === "string" && typeof value.code === "string") {
      return value as GitHubErrorResponse
    }
  } catch {
    // Fall back to a stable message when the dependency returned no JSON.
  }
  return { error: `GitHub request failed (${response.status})`, code: "github_api_failed" }
}

export function toErrorResponse(error: unknown, fallback: string): GitHubErrorResponse {
  const detail = error as Partial<GitHubErrorResponse>
  return {
    error: typeof detail.error === "string" ? detail.error : fallback,
    code: typeof detail.code === "string" ? detail.code as GitHubErrorResponse["code"] : "github_api_failed",
  }
}

async function load<T>(resource: ResourceDefinition<T>, projectPath: string, force = false): Promise<void> {
  const store = storeFor(resource, projectPath)
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

  store.request = authFetch(resource.endpoint(projectPath))
    .then(async (response) => {
      if (!response.ok) throw await responseError(response)
      const data = await response.json() as T
      store.fetchedAt = Date.now()
      publish(store, { data, error: null, loading: false, refreshing: false })
      if (resource.settling?.(data) && store.settleAttempts < SETTLE_MAX_ATTEMPTS) {
        store.settleAttempts += 1
        store.settleTimer = window.setTimeout(() => {
          store.settleTimer = null
          void load(resource, projectPath, true)
        }, SETTLE_RETRY_MS)
      } else {
        store.settleAttempts = 0
      }
    })
    .catch((error: unknown) => {
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

function useGitHubResource<T>(resource: ResourceDefinition<T>, projectPath: string | null, enabled: boolean) {
  const path = projectPath ?? ""
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
    void load(resource, path)
    const interval = window.setInterval(() => { void load(resource, path) }, resource.pollIntervalMs)
    return () => window.clearInterval(interval)
  }, [resource, enabled, path])

  const refresh = useCallback(() => path ? load(resource, path, true) : Promise.resolve(), [resource, path])
  return { ...state, refresh }
}

export function useGitHubActions(projectPath: string | null, enabled: boolean) {
  return useGitHubResource(actions, projectPath, enabled)
}

export function useGitHubPulls(projectPath: string | null, enabled: boolean) {
  return useGitHubResource(pulls, projectPath, enabled)
}

export function useGitHubIssues(projectPath: string | null, enabled: boolean) {
  return useGitHubResource(issues, projectPath, enabled)
}

export function useGitHubPullSessions(projectPath: string | null, enabled: boolean) {
  return useGitHubResource(pullSessions, projectPath, enabled)
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await authFetch(url)
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<T>
}

export function fetchGitHubActionsJobs(projectPath: string, runId: number): Promise<GitHubActionsJobsResponse> {
  return fetchJson(`/api/github/actions/jobs?cwd=${encodeURIComponent(projectPath)}&runId=${runId}`)
}

export function fetchGitHubPullFiles(projectPath: string, number: number): Promise<GitHubPullFilesResponse> {
  return fetchJson(`/api/github/pulls/files?cwd=${encodeURIComponent(projectPath)}&number=${number}`)
}

export function __resetGitHubStoreForTest(): void {
  for (const resource of [actions, pulls, issues, pullSessions]) {
    for (const store of resource.stores.values()) {
      if (store.settleTimer !== null) window.clearTimeout(store.settleTimer)
    }
    resource.stores.clear()
  }
}
