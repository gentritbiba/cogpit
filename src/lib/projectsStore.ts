// ── Projects ────────────────────────────────────────────────────────────
//
// One `/api/projects` list per device and signed-in user, shared by every
// surface that offers projects. It shows the cached list at once and
// revalidates with `If-None-Match` whenever a surface opens, a lookup asks,
// or the session list changes while anyone shows it.

import { useCallback, useEffect, useSyncExternalStore } from "react"
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

const FALLBACK_POLL_INTERVAL = 60_000
const projectKeyOf = (project: ProjectInfo) => project.dirName
const noSubscription = () => () => {}

class ProjectsStore {
  snapshot: ProjectsSnapshot
  private readonly listeners = new Set<() => void>()
  private etag: string | null = null
  // A change was announced while nothing could read it (hidden, or mid-request).
  private stale = false
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

  /** Ask the server again; with its ETag an unchanged list costs a 304. */
  revalidate(): Promise<ProjectInfo[]> {
    if (this.inFlight) return this.inFlight
    this.stale = false
    const request = this.request().finally(() => {
      this.inFlight = null
      if (this.stale) this.invalidate()
    })
    this.inFlight = request
    return request
  }

  /** The projects may have changed: read them now if anyone shows them, otherwise once someone does. */
  invalidate(): void {
    this.stale = true
    if (this.inFlight) return
    if (this.listeners.size > 0 && document.visibilityState === "visible") void this.revalidate()
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
      if (document.visibilityState === "visible" && this.stale) void this.revalidate()
    }
    document.addEventListener("visibilitychange", onVisible)
    let poll: ReturnType<typeof setInterval> | undefined
    const stopEvents = subscribeSessionListEvents({
      onVersion: () => this.invalidate(),
      // An older server pushes nothing: read again on a slow timer instead.
      onUnsupported: () => {
        clearInterval(poll)
        poll = setInterval(() => this.invalidate(), FALLBACK_POLL_INTERVAL)
      },
      onSupported: () => {
        clearInterval(poll)
        this.invalidate()
      },
    })
    this.stopFollowing = () => {
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(poll)
      stopEvents()
    }
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

/**
 * Every project on the active device: the last known list at once, read again
 * whenever a surface showing it opens (`enabled` turns on) and followed while open.
 */
export function useProjects(enabled = true): ProjectsSnapshot & { refresh: () => Promise<void> } {
  const projects = currentStore()
  const snapshot = useSyncExternalStore(
    enabled ? projects.subscribe : noSubscription,
    projects.getSnapshot,
    projects.getSnapshot,
  )
  useEffect(() => {
    if (enabled) void projects.revalidate()
  }, [enabled, projects])
  const refresh = useCallback(async () => {
    await projects.revalidate()
  }, [projects])
  return { ...snapshot, refresh }
}

/** The projects for a one-off lookup, revalidated so a folder opened since is in it. */
export function loadProjects(): Promise<ProjectInfo[]> {
  return currentStore().revalidate()
}

export function __resetProjectsStoreForTest(): void {
  store = null
}
