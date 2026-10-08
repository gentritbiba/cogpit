import { useCallback, useSyncExternalStore } from "react"
import { authFetch } from "@/lib/auth"
import type { DelegatedTask } from "../../shared/contracts/orchestration"

const POLL_MS = 3000
const NONE: DelegatedTask[] = []

interface Watch {
  tasks: DelegatedTask[]
  listeners: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
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
  authFetch(`/api/delegated-tasks?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) return
      const { tasks } = await response.json() as { tasks: DelegatedTask[] }
      if (controller.signal.aborted || JSON.stringify(tasks) === JSON.stringify(watch.tasks)) return
      watch.tasks = tasks
      for (const listener of watch.listeners) listener()
    })
    .catch(() => { /* The next poll retries. */ })
    .finally(next)
}

function subscribe(sessionId: string, listener: () => void): () => void {
  let watch = watches.get(sessionId)
  if (!watch) {
    watch = { tasks: NONE, listeners: new Set() }
    watches.set(sessionId, watch)
    poll(sessionId, watch)
  }
  watch.listeners.add(listener)
  const owned = watch
  return () => {
    owned.listeners.delete(listener)
    if (owned.listeners.size > 0) return
    owned.controller?.abort()
    clearTimeout(owned.timer)
    watches.delete(sessionId)
  }
}

/**
 * The tasks a session handed to sessions it started, kept current while the
 * tab is visible, with one poll however many places show them.
 */
export function useDelegatedTasks(sessionId: string | null): DelegatedTask[] {
  // Stable per session: a new subscribe on every render would drop the watch and fetch again.
  const subscribeToSession = useCallback(
    (listener: () => void) => (sessionId ? subscribe(sessionId, listener) : () => {}),
    [sessionId],
  )
  const snapshot = useCallback(() => (sessionId ? watches.get(sessionId)?.tasks ?? NONE : NONE), [sessionId])
  return useSyncExternalStore(subscribeToSession, snapshot)
}
