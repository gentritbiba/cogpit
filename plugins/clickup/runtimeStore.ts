import { useCallback, useEffect, useSyncExternalStore } from "react"
import type { PluginClient } from "@cogpit/plugin-sdk"
import {
  ClickUpDataError, parseListResponse, parseTasksPage, parseViewerResponse,
  type ClickUpErrorResponse, type ClickUpListTasksResponse, type ClickUpMyTasksResponse,
  type ClickUpUser, type ClickUpWorkspace,
} from "@cogpit/plugin-integrations"

export interface RuntimeStatus {
  configured: boolean
  workspace: ClickUpWorkspace | null
  list: { id: string; label: string } | null
  viewer: ClickUpUser | null
}
export interface ResourceState<T> {
  data: T | null
  error: ClickUpErrorResponse | null
  loading: boolean
  refreshing: boolean
}
export interface Resource<T> {
  getSnapshot: () => ResourceState<T>
  subscribe: (listener: () => void) => () => void
  load: (force?: boolean) => Promise<void>
  dispose: () => void
  pollIntervalMs: number
}
const EMPTY_STATE = { data: null, error: null, loading: false, refreshing: false }
const SETUP_ERRORS = new Set(["clickup_not_configured", "clickup_auth_failed", "project_unlinked"])
const CLOSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const CACHE_MS = 8_000

function dataError(code: ClickUpErrorResponse["code"], error: string): ClickUpErrorResponse { return { code, error } }
function errorResponse(error: unknown): ClickUpErrorResponse {
  if (error instanceof ClickUpDataError) return dataError(error.code, error.message)
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined
  switch (code) {
    case "CONNECTION_REQUIRED": case "clickup_not_configured": return dataError("clickup_not_configured", "Connect ClickUp using Connections above this panel.")
    case "RESOURCE_REQUIRED": case "project_unlinked": return dataError("project_unlinked", "Choose a workspace and project list in Connections above this panel.")
    case "RATE_LIMITED": case "clickup_rate_limited": return dataError("clickup_rate_limited", "Too many requests. Try again shortly.")
    case "INVALID_RESPONSE": return dataError("invalid_response", "ClickUp returned an invalid response.")
    case "STALE_ACTIVATION": case "PLUGIN_DISABLED": case "PERMISSION_REQUIRED": return dataError("clickup_auth_failed", "Reopen ClickUp after updating its connection or permissions.")
    default: return dataError("clickup_api_failed", "Unable to load ClickUp data. Try again.")
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function selection(value: unknown): { id: string; label: string } | null {
  const record = object(value)
  return record && typeof record.id === "string" && typeof record.label === "string" ? { id: record.id, label: record.label } : null
}
export function parseRuntimeStatus(value: unknown): Omit<RuntimeStatus, "viewer"> {
  const record = object(value), selected = object(record?.selected)
  if (!record || typeof record.configured !== "boolean" || !selected) throw new ClickUpDataError(502, "invalid_response", "Invalid connection status.")
  const workspace = selection(selected.workspace)
  return { configured: record.configured, workspace: workspace ? { id: workspace.id, name: workspace.label } : null, list: selection(selected.list) }
}

function createResource<T>(fetch: (signal: AbortSignal) => Promise<T>, pollIntervalMs: number, now: () => number): Resource<T> {
  let snapshot: ResourceState<T> = EMPTY_STATE
  let fetchedAt: number | null = null
  let request: Promise<void> | null = null
  const controller = new AbortController()
  let disposed = false
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (value: ResourceState<T>) => { snapshot = value; for (const listener of listeners) listener() }
  return {
    pollIntervalMs,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    load(force = false) {
      if (disposed) return Promise.resolve()
      if (request) return request
      if (!force && snapshot.error && SETUP_ERRORS.has(snapshot.error.code)) return Promise.resolve()
      if (!force && fetchedAt !== null && now() - fetchedAt < CACHE_MS) return Promise.resolve()
      if (force || snapshot.data === null) publish({ ...snapshot, error: force ? null : snapshot.error, loading: snapshot.data === null, refreshing: snapshot.data !== null })
      const current = generation, signal = controller.signal
      request = Promise.resolve().then(() => { signal.throwIfAborted(); return fetch(signal) }).then((data) => {
        if (generation !== current) return
        fetchedAt = now()
        publish({ data, error: null, loading: false, refreshing: false })
      }).catch((error: unknown) => {
        if (generation === current) publish({ ...snapshot, error: errorResponse(error), loading: false, refreshing: false })
      }).finally(() => { if (generation === current) request = null })
      return request
    },
    dispose() {
      disposed = true
      generation++
      controller.abort()
      request = null
      fetchedAt = null
      snapshot = EMPTY_STATE
      listeners.clear()
    },
  }
}

export function createClickUpRuntimeStore(client: Pick<PluginClient, "connections">, now: () => number = Date.now) {
  const request = (operation: string, args: Record<string, string | number | boolean>, signal: AbortSignal) => client.connections.request("clickup", operation, args, { signal })
  const status = createResource<RuntimeStatus>(async (signal) => {
    const connection = parseRuntimeStatus(await client.connections.status("clickup", { signal }))
    if (!connection.configured) return { ...connection, viewer: null }
    const viewer = parseViewerResponse(await request("viewer", {}, signal))
    return { ...connection, viewer }
  }, 5 * 60_000, now)
  async function identity(signal: AbortSignal) {
    await status.load()
    signal.throwIfAborted()
    const state = status.getSnapshot()
    if (state.error) throw state.error
    if (!state.data?.configured || !state.data.viewer) throw dataError("clickup_not_configured", "Connect ClickUp.")
    if (!state.data.workspace) throw dataError("project_unlinked", "Choose a workspace.")
    return { workspace: state.data.workspace, viewer: state.data.viewer, list: state.data.list }
  }
  async function pages(operation: string, args: Record<string, string | number | boolean>, signal: AbortSignal, maxPages = 3) {
    const tasks = new Map<string, ClickUpMyTasksResponse["tasks"][number]>()
    for (let page = 0; page < maxPages; page++) {
      signal.throwIfAborted()
      const result = parseTasksPage(await request(operation, { ...args, page }, signal))
      signal.throwIfAborted()
      for (const task of result.tasks) tasks.set(task.id, task)
      if (result.lastPage) return { tasks: [...tasks.values()], truncated: false }
    }
    return { tasks: [...tasks.values()], truncated: true }
  }
  const mine = createResource<ClickUpMyTasksResponse>(async (signal) => {
    const { workspace, viewer } = await identity(signal)
    return { workspace, viewer, ...await pages("mine", {}, signal) }
  }, 60_000, now)
  const project = createResource<ClickUpListTasksResponse>(async (signal) => {
    const { workspace, viewer, list: selected } = await identity(signal)
    if (!selected) throw dataError("project_unlinked", "Choose a project list.")
    const [list, open, recent] = await Promise.all([
      request("list", {}, signal).then(parseListResponse),
      pages("tasks", { closed: false }, signal),
      pages("tasks", { closed: true, updatedAfter: Math.max(0, now() - CLOSED_WINDOW_MS) }, signal, 1),
    ])
    if (list.id !== selected.id) throw new ClickUpDataError(502, "invalid_response", "ClickUp returned a different list.")
    const seen = new Set(open.tasks.map((task) => task.id))
    return { workspace, viewer, list, tasks: [...open.tasks, ...recent.tasks.filter((task) => task.status.type === "closed" && !seen.has(task.id))], truncated: open.truncated }
  }, 60_000, now)
  return { status, mine, project, dispose() { status.dispose(); mine.dispose(); project.dispose() } }
}
export type ClickUpRuntimeStore = ReturnType<typeof createClickUpRuntimeStore>

export function useRuntimeResource<T>(resource: Resource<T>, enabled: boolean) {
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
  useEffect(() => {
    if (!enabled) return
    void resource.load()
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void resource.load() }, resource.pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [resource, enabled])
  const refresh = useCallback(() => resource.load(true), [resource])
  return { ...state, refresh }
}
