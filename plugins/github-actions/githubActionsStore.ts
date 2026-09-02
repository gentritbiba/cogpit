import { useCallback, useEffect, useSyncExternalStore } from "react"
import type {
  GitHubActionsErrorResponse,
  GitHubActionsJobsResponse,
  GitHubActionsRunsResponse,
} from "../../shared/contracts/githubActions"
import { authFetch } from "@/plugin-api"

export interface GitHubActionsState {
  data: GitHubActionsRunsResponse | null
  error: GitHubActionsErrorResponse | null
  loading: boolean
  refreshing: boolean
}

interface StoreEntry {
  snapshot: GitHubActionsState
  listeners: Set<() => void>
  request: Promise<void> | null
  fetchedAt: number
}

const EMPTY_STATE: GitHubActionsState = {
  data: null,
  error: null,
  loading: false,
  refreshing: false,
}
const stores = new Map<string, StoreEntry>()
const CACHE_WINDOW_MS = 8_000
const POLL_INTERVAL_MS = 10_000
const SETUP_ERROR_CODES = new Set<GitHubActionsErrorResponse["code"]>([
  "gh_missing",
  "gh_auth_required",
  "no_git_repository",
  "no_github_remote",
])

function storeFor(projectPath: string): StoreEntry {
  let store = stores.get(projectPath)
  if (!store) {
    store = {
      snapshot: EMPTY_STATE,
      listeners: new Set(),
      request: null,
      fetchedAt: 0,
    }
    stores.set(projectPath, store)
  }
  return store
}

function publish(store: StoreEntry, snapshot: GitHubActionsState): void {
  store.snapshot = snapshot
  for (const listener of store.listeners) listener()
}

async function responseError(response: Response): Promise<GitHubActionsErrorResponse> {
  try {
    const value = await response.json() as Partial<GitHubActionsErrorResponse>
    if (typeof value.error === "string" && typeof value.code === "string") {
      return value as GitHubActionsErrorResponse
    }
  } catch {
    // Fall back to a stable message when the dependency returned no JSON.
  }
  return { error: `GitHub Actions request failed (${response.status})`, code: "github_api_failed" }
}

async function load(projectPath: string, force = false): Promise<void> {
  const store = storeFor(projectPath)
  if (store.request) return store.request
  if (!force && store.snapshot.error && SETUP_ERROR_CODES.has(store.snapshot.error.code)) return
  if (!force && store.fetchedAt > 0 && Date.now() - store.fetchedAt < CACHE_WINDOW_MS) return

  publish(store, {
    ...store.snapshot,
    error: null,
    loading: store.snapshot.data === null,
    refreshing: store.snapshot.data !== null,
  })

  store.request = authFetch(
    `/api/github-actions?cwd=${encodeURIComponent(projectPath)}&limit=20`,
  )
    .then(async (response) => {
      if (!response.ok) throw await responseError(response)
      const data = await response.json() as GitHubActionsRunsResponse
      store.fetchedAt = Date.now()
      publish(store, { data, error: null, loading: false, refreshing: false })
    })
    .catch((error: unknown) => {
      const detail = error as Partial<GitHubActionsErrorResponse>
      publish(store, {
        ...store.snapshot,
        error: {
          error: typeof detail.error === "string" ? detail.error : "Unable to load GitHub Actions",
          code: typeof detail.code === "string"
            ? detail.code as GitHubActionsErrorResponse["code"]
            : "github_api_failed",
        },
        loading: false,
        refreshing: false,
      })
    })
    .finally(() => {
      store.request = null
    })

  return store.request
}

function subscribe(projectPath: string, listener: () => void): () => void {
  if (!projectPath) return () => undefined
  const store = storeFor(projectPath)
  store.listeners.add(listener)
  return () => store.listeners.delete(listener)
}

function snapshot(projectPath: string): GitHubActionsState {
  return projectPath ? storeFor(projectPath).snapshot : EMPTY_STATE
}

export function useGitHubActions(projectPath: string | null, enabled: boolean) {
  const path = projectPath ?? ""
  const state = useSyncExternalStore(
    useCallback((listener) => subscribe(path, listener), [path]),
    useCallback(() => snapshot(path), [path]),
    () => EMPTY_STATE,
  )

  useEffect(() => {
    if (!enabled || !path) return
    void load(path)
    const interval = window.setInterval(() => { void load(path) }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [enabled, path])

  const refresh = useCallback(() => path ? load(path, true) : Promise.resolve(), [path])
  return { ...state, refresh }
}

export async function fetchGitHubActionsJobs(
  projectPath: string,
  runId: number,
): Promise<GitHubActionsJobsResponse> {
  const response = await authFetch(
    `/api/github-actions/jobs?cwd=${encodeURIComponent(projectPath)}&runId=${runId}`,
  )
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<GitHubActionsJobsResponse>
}

export function __resetGitHubActionsStoreForTest(): void {
  stores.clear()
}
