// ── Projects ────────────────────────────────────────────────────────────
//
// One `/api/projects` list per device and signed-in user, shared by every
// surface that offers projects. It shows the cached list at once, revalidates
// with `If-None-Match` when the session list changes while anyone shows it,
// and is read once more whenever its first viewer arrives.

import { useCallback, useSyncExternalStore } from "react"
import type { ProjectInfo } from "@/components/Dashboard/types"
import { authFetch } from "@/lib/auth"
import { getActiveDeviceScope, getActiveIdentity } from "@/lib/device"
import { readCachedList, sessionListCacheKeys, writeCachedList } from "@/lib/sessionListCache"
import { subscribeSessionListEvents } from "@/lib/sessionListEvents"
import { shareList } from "@/lib/structuralShare"

export interface ProjectsSnapshot {
  projects: ProjectInfo[]
  /** The server answered at least once. */
  loaded: boolean
  error: string | null
}

const projectKeyOf = (project: ProjectInfo) => project.dirName
const noSubscription = () => () => {}

class ProjectsStore {
  snapshot: ProjectsSnapshot
  private readonly listeners = new Set<() => void>()
  private etag: string | null = null
  private stale = true
  private changedDuringLoad = false
  private inFlight: Promise<ProjectInfo[]> | null = null
  private stopFollowing: (() => void) | null = null

  constructor(readonly scope: string) {
    this.snapshot = {
      projects: readCachedList<ProjectInfo>(sessionListCacheKeys.projects) ?? [],
      loaded: false,
      error: null,
    }
  }

  readonly getSnapshot = (): ProjectsSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.follow()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.unfollow()
    }
  }

  /** The projects, read again only when they may have changed since the last answer. */
  load(): Promise<ProjectInfo[]> {
    if (this.inFlight) return this.inFlight
    if (!this.stale) return Promise.resolve(this.snapshot.projects)
    this.stale = false
    const request = this.request().finally(() => {
      this.inFlight = null
      // Unfollowed, nothing tells the store when the projects change.
      if (this.listeners.size === 0) this.stale = true
      if (!this.changedDuringLoad) return
      this.changedDuringLoad = false
      this.invalidate()
    })
    this.inFlight = request
    return request
  }

  invalidate(): void {
    this.stale = true
    if (this.inFlight) {
      this.changedDuringLoad = true
      return
    }
    if (this.listeners.size > 0 && document.visibilityState === "visible") void this.load()
  }

  private async request(): Promise<ProjectInfo[]> {
    try {
      const response = await authFetch(
        "/api/projects",
        this.etag ? { headers: { "If-None-Match": this.etag } } : undefined,
      )
      if (response.status === 304) {
        this.publish({ ...this.snapshot, loaded: true, error: null })
        return this.snapshot.projects
      }
      if (!response.ok) throw new Error("Failed to fetch projects")
      const data: unknown = await response.json()
      const fetched = Array.isArray(data) ? data as ProjectInfo[] : []
      const projects = shareList(this.snapshot.projects, fetched, projectKeyOf)
      this.etag = response.headers.get("ETag")
      if (projects !== this.snapshot.projects) writeCachedList(sessionListCacheKeys.projects, projects)
      this.publish({ projects, loaded: true, error: null })
      return projects
    } catch (error) {
      this.stale = true
      this.publish({
        ...this.snapshot,
        loaded: true,
        error: error instanceof Error ? error.message : "Failed to load projects",
      })
      return this.snapshot.projects
    }
  }

  private publish(next: ProjectsSnapshot): void {
    const current = this.snapshot
    if (current.projects === next.projects && current.loaded === next.loaded && current.error === next.error) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private follow(): void {
    const onVisible = () => {
      if (document.visibilityState === "visible" && this.stale) void this.load()
    }
    document.addEventListener("visibilitychange", onVisible)
    const stopEvents = subscribeSessionListEvents({ onVersion: () => this.invalidate(), onUnsupported: () => {} })
    this.stopFollowing = () => {
      document.removeEventListener("visibilitychange", onVisible)
      stopEvents()
    }
    // Nothing followed the server while nobody showed the projects.
    this.invalidate()
  }

  private unfollow(): void {
    this.stopFollowing?.()
    this.stopFollowing = null
  }
}

let store: ProjectsStore | null = null

function currentStore(): ProjectsStore {
  const scope = JSON.stringify([getActiveDeviceScope(), getActiveIdentity()])
  if (store?.scope !== scope) store = new ProjectsStore(scope)
  return store
}

/** Every project on the active device; followed while `enabled`, the last known list otherwise. */
export function useProjects(enabled = true): ProjectsSnapshot & { refresh: () => Promise<void> } {
  const projects = currentStore()
  const snapshot = useSyncExternalStore(
    enabled ? projects.subscribe : noSubscription,
    projects.getSnapshot,
    projects.getSnapshot,
  )
  const refresh = useCallback(async () => {
    projects.invalidate()
    await projects.load()
  }, [projects])
  return { ...snapshot, refresh }
}

/** The projects for a one-off lookup: the followed list when it is current, otherwise read again. */
export function loadProjects(): Promise<ProjectInfo[]> {
  return currentStore().load()
}

export function __resetProjectsStoreForTest(): void {
  store = null
}
