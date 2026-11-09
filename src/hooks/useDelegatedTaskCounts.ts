import { useCallback, useSyncExternalStore } from "react"
import { fetchIfChanged } from "@/lib/conditionalFetch"
import { countDelegatedTasks, type DelegatedTask, type DelegatedTaskCounts } from "../../shared/contracts/orchestration"

const POLL_MS = 3000

export const NO_DELEGATED_TASKS: DelegatedTaskCounts = { total: 0, running: 0, unread: 0, unreadRunning: 0 }

/** The counts view, or the full list from a server too old to count. */
type CountsResponse = { counts: DelegatedTaskCounts } | { tasks: DelegatedTask[] }

const sameCounts = (a: DelegatedTaskCounts, b: DelegatedTaskCounts) =>
  a.total === b.total && a.running === b.running && a.unread === b.unread && a.unreadRunning === b.unreadRunning

interface Watch {
  counts: DelegatedTaskCounts
  etag: string | null
  listeners: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
  inFlight: boolean
  onVisible: () => void
}

/** One poll per session, shared by everything that shows its delegated work. */
const watches = new Map<string, Watch>()

function poll(sessionId: string, watch: Watch): void {
  const controller = new AbortController()
  watch.controller = controller
  const next = () => {
    if (!controller.signal.aborted) watch.timer = setTimeout(() => poll(sessionId, watch), POLL_MS)
  }
  if (document.visibilityState !== "visible") return next()
  watch.inFlight = true
  fetchIfChanged<CountsResponse>(
    `/api/delegated-tasks?sessionId=${encodeURIComponent(sessionId)}&view=counts`,
    watch.etag,
    { signal: controller.signal },
  )
    .then((result) => {
      if (result.kind !== "changed" || controller.signal.aborted) return
      watch.etag = result.etag
      const counts = "counts" in result.value ? result.value.counts : countDelegatedTasks(result.value.tasks)
      if (sameCounts(counts, watch.counts)) return
      watch.counts = counts
      for (const listener of watch.listeners) listener()
    })
    .catch(() => { /* The next poll retries. */ })
    .finally(() => {
      watch.inFlight = false
      next()
    })
}

function subscribe(sessionId: string, listener: () => void): () => void {
  let watch = watches.get(sessionId)
  if (!watch) {
    const created: Watch = {
      counts: NO_DELEGATED_TASKS,
      etag: null,
      listeners: new Set(),
      inFlight: false,
      // Coming back to the tab reads at once instead of waiting out the timer.
      onVisible: () => {
        if (document.visibilityState !== "visible" || created.inFlight) return
        clearTimeout(created.timer)
        poll(sessionId, created)
      },
    }
    watch = created
    watches.set(sessionId, watch)
    document.addEventListener("visibilitychange", watch.onVisible)
    poll(sessionId, watch)
  }
  watch.listeners.add(listener)
  const owned = watch
  return () => {
    owned.listeners.delete(listener)
    if (owned.listeners.size > 0) return
    owned.controller?.abort()
    clearTimeout(owned.timer)
    document.removeEventListener("visibilitychange", owned.onVisible)
    watches.delete(sessionId)
  }
}

/**
 * How many tasks a session handed to sessions it started, and how many of
 * them run or wait to be read, kept current while the tab is visible, with
 * one poll however many places show them.
 */
export function useDelegatedTaskCounts(sessionId: string | null): DelegatedTaskCounts {
  // Stable per session: a new subscribe on every render would drop the watch and fetch again.
  const subscribeToSession = useCallback(
    (listener: () => void) => (sessionId ? subscribe(sessionId, listener) : () => {}),
    [sessionId],
  )
  const snapshot = useCallback(
    () => (sessionId ? watches.get(sessionId)?.counts ?? NO_DELEGATED_TASKS : NO_DELEGATED_TASKS),
    [sessionId],
  )
  return useSyncExternalStore(subscribeToSession, snapshot)
}
