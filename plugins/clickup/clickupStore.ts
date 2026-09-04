import { useCallback, useEffect, useSyncExternalStore } from "react"
import type {
  ClickUpErrorResponse,
  ClickUpListTasksResponse,
  ClickUpListsResponse,
  ClickUpMyTasksResponse,
  ClickUpProjectLinkResponse,
  ClickUpSpacesResponse,
  ClickUpStatusResponse,
} from "../../shared/contracts/clickup"
import { authFetch } from "@/plugin-api"

export interface ClickUpResourceState<T> {
  data: T | null
  error: ClickUpErrorResponse | null
  loading: boolean
  refreshing: boolean
}

interface StoreEntry<T> {
  snapshot: ClickUpResourceState<T>
  listeners: Set<() => void>
  request: Promise<void> | null
  fetchedAt: number
}

interface ResourceDefinition<T> {
  endpoint: (key: string) => string
  pollIntervalMs: number
  fallbackError: string
  stores: Map<string, StoreEntry<T>>
}

const EMPTY_STATE: ClickUpResourceState<never> = {
  data: null,
  error: null,
  loading: false,
  refreshing: false,
}
const CACHE_WINDOW_MS = 8_000
/** Errors the user has to fix on their side; polling again would only repeat them. */
const SETUP_ERROR_CODES = new Set<ClickUpErrorResponse["code"]>([
  "clickup_not_configured",
  "clickup_auth_failed",
  "project_unlinked",
])
/** Resources that ignore their key; every subscriber shares one entry. */
const GLOBAL_KEY = "*"

const status: ResourceDefinition<ClickUpStatusResponse> = {
  endpoint: () => "/api/clickup/status",
  pollIntervalMs: 5 * 60_000,
  fallbackError: "Unable to reach ClickUp",
  stores: new Map(),
}

const myTasks: ResourceDefinition<ClickUpMyTasksResponse> = {
  endpoint: () => "/api/clickup/tasks/mine",
  pollIntervalMs: 60_000,
  fallbackError: "Unable to load your ClickUp tasks",
  stores: new Map(),
}

const listTasks: ResourceDefinition<ClickUpListTasksResponse> = {
  endpoint: (projectPath) => `/api/clickup/tasks/list?cwd=${encodeURIComponent(projectPath)}`,
  pollIntervalMs: 60_000,
  fallbackError: "Unable to load the linked ClickUp list",
  stores: new Map(),
}

function storeFor<T>(resource: ResourceDefinition<T>, key: string): StoreEntry<T> {
  let store = resource.stores.get(key)
  if (!store) {
    store = { snapshot: EMPTY_STATE, listeners: new Set(), request: null, fetchedAt: 0 }
    resource.stores.set(key, store)
  }
  return store
}

function publish<T>(store: StoreEntry<T>, snapshot: ClickUpResourceState<T>): void {
  store.snapshot = snapshot
  for (const listener of store.listeners) listener()
}

async function responseError(response: Response): Promise<ClickUpErrorResponse> {
  try {
    const value = await response.json() as Partial<ClickUpErrorResponse>
    if (typeof value.error === "string" && typeof value.code === "string") {
      return value as ClickUpErrorResponse
    }
  } catch {
    // Fall back to a stable message when the server returned no JSON.
  }
  return { error: `ClickUp request failed (${response.status})`, code: "clickup_api_failed" }
}

export function toErrorResponse(error: unknown, fallback: string): ClickUpErrorResponse {
  const detail = error as Partial<ClickUpErrorResponse>
  return {
    error: typeof detail.error === "string" ? detail.error : fallback,
    code: typeof detail.code === "string" ? detail.code as ClickUpErrorResponse["code"] : "clickup_api_failed",
  }
}

async function load<T>(resource: ResourceDefinition<T>, key: string, force = false): Promise<void> {
  const store = storeFor(resource, key)
  if (store.request) return store.request
  if (!force && store.snapshot.error && SETUP_ERROR_CODES.has(store.snapshot.error.code)) return
  if (!force && store.fetchedAt > 0 && Date.now() - store.fetchedAt < CACHE_WINDOW_MS) return

  // A background poll stays invisible; only a user refresh or a first load
  // changes the loading flags.
  if (force || store.snapshot.data === null) {
    publish(store, {
      ...store.snapshot,
      error: force ? null : store.snapshot.error,
      loading: store.snapshot.data === null,
      refreshing: store.snapshot.data !== null,
    })
  }

  store.request = authFetch(resource.endpoint(key))
    .then(async (response) => {
      if (!response.ok) throw await responseError(response)
      const data = await response.json() as T
      store.fetchedAt = Date.now()
      publish(store, { data, error: null, loading: false, refreshing: false })
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

function useClickUpResource<T>(resource: ResourceDefinition<T>, key: string | null, enabled: boolean) {
  const storeKey = key ?? ""
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => {
      if (!storeKey) return () => undefined
      const store = storeFor(resource, storeKey)
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }, [resource, storeKey]),
    useCallback(
      (): ClickUpResourceState<T> => storeKey ? storeFor(resource, storeKey).snapshot : EMPTY_STATE,
      [resource, storeKey],
    ),
    (): ClickUpResourceState<T> => EMPTY_STATE,
  )

  useEffect(() => {
    if (!enabled || !storeKey) return
    void load(resource, storeKey)
    const interval = window.setInterval(() => { void load(resource, storeKey) }, resource.pollIntervalMs)
    return () => window.clearInterval(interval)
  }, [resource, enabled, storeKey])

  const refresh = useCallback(
    () => storeKey ? load(resource, storeKey, true) : Promise.resolve(),
    [resource, storeKey],
  )
  return { ...state, refresh }
}

export function useClickUpStatus(enabled: boolean) {
  return useClickUpResource(status, GLOBAL_KEY, enabled)
}

export function useClickUpMyTasks(enabled: boolean) {
  return useClickUpResource(myTasks, GLOBAL_KEY, enabled)
}

export function useClickUpListTasks(projectPath: string | null, enabled: boolean) {
  return useClickUpResource(listTasks, projectPath, enabled)
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(url, init)
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<T>
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

/** Every task resource starts over once the credential changes. */
function forgetTaskStores(): void {
  for (const resource of [myTasks, listTasks]) {
    for (const store of resource.stores.values()) {
      store.fetchedAt = 0
      publish(store, EMPTY_STATE)
    }
  }
}

export async function saveClickUpToken(token: string): Promise<void> {
  await requestJson<ClickUpStatusResponse>("/api/clickup/token", jsonInit("POST", { token }))
  forgetTaskStores()
  await load(status, GLOBAL_KEY, true)
}

export async function forgetClickUpToken(): Promise<void> {
  await requestJson<ClickUpStatusResponse>("/api/clickup/token", { method: "DELETE" })
  forgetTaskStores()
  await load(status, GLOBAL_KEY, true)
}

export async function linkClickUpProject(projectPath: string, listId: string | null): Promise<void> {
  await requestJson<ClickUpProjectLinkResponse>(
    "/api/clickup/project-list",
    jsonInit("PUT", { cwd: projectPath, listId }),
  )
  const store = storeFor(listTasks, projectPath)
  store.fetchedAt = 0
  publish(store, EMPTY_STATE)
  if (listId !== null) await load(listTasks, projectPath, true)
}

export function fetchClickUpSpaces(): Promise<ClickUpSpacesResponse> {
  return requestJson("/api/clickup/spaces")
}

export function fetchClickUpLists(spaceId: string): Promise<ClickUpListsResponse> {
  return requestJson(`/api/clickup/lists?spaceId=${encodeURIComponent(spaceId)}`)
}

export function __resetClickUpStoreForTest(): void {
  for (const resource of [status, myTasks, listTasks]) resource.stores.clear()
}
