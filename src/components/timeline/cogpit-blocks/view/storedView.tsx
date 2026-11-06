import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { authFetch } from "@/lib/auth"
import { getActiveDeviceScope } from "@/lib/device"
import { withViewTheme } from "../../../../../shared/views/frame"
import { formatViewReference, viewVersionPath, VIEWS_PATH, type StoredViewVersion, type ViewReference, type ViewSummary } from "../../../../../shared/views/stored"
import type { PreparedView } from "./ViewFrame"

export type StoredState =
  | { status: "loading" }
  | { status: "ready"; view: StoredViewVersion }
  | { status: "missing" | "failed" }

const VIEWS_CHANGED = "cogpit-views-changed"

/** Tells every shown list of views, and every card, that a view changed. */
export function announceViewsChanged(): void {
  window.dispatchEvent(new Event(VIEWS_CHANGED))
}

export function onViewsChanged(listener: () => void): () => void {
  window.addEventListener(VIEWS_CHANGED, listener)
  return () => window.removeEventListener(VIEWS_CHANGED, listener)
}

/**
 * The newest version of each view, per device, that this window has heard
 * of: from any card's fetch, the views list, or a check when the user comes
 * back to the window. One store, so a card learns of a build published after
 * it mounted without fetching anything itself. Each answer is filed under
 * the device connection its request went to, so a late one, or one from a
 * device's earlier address, cannot leak into another.
 */
const newest = new Map<string, number>()
const subscribers = new Set<() => void>()
const checkedAt = new Map<string, number>()
const RECHECK_MS = 5_000

/** The device, and its connection, a request made now goes to. */
export function viewsScope(): string {
  return getActiveDeviceScope()
}

export function rememberNewestVersions(scope: string, views: ReadonlyArray<Pick<ViewSummary, "id" | "latestVersion">>): void {
  let changed = false
  for (const { id, latestVersion } of views) {
    const key = `${scope} ${id}`
    if (latestVersion === null || (newest.get(key) ?? 0) >= latestVersion) continue
    newest.set(key, latestVersion)
    changed = true
  }
  if (changed) for (const notify of subscribers) notify()
}

function checkNewestVersions(): void {
  const scope = viewsScope()
  if (Date.now() - (checkedAt.get(scope) ?? 0) < RECHECK_MS) return
  checkedAt.set(scope, Date.now())
  authFetch(VIEWS_PATH)
    .then(async (response) => { if (response.ok) rememberNewestVersions(scope, ((await response.json()) as { views: ViewSummary[] }).views) })
    .catch(() => {})
}

const checkWhenVisible = () => { if (document.visibilityState === "visible") checkNewestVersions() }
let stopListening: (() => void) | null = null

function subscribe(notify: () => void): () => void {
  if (subscribers.size === 0) {
    window.addEventListener("focus", checkNewestVersions)
    document.addEventListener("visibilitychange", checkWhenVisible)
    const stopChanges = onViewsChanged(checkNewestVersions)
    stopListening = () => {
      window.removeEventListener("focus", checkNewestVersions)
      document.removeEventListener("visibilitychange", checkWhenVisible)
      stopChanges()
    }
  }
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
    if (subscribers.size === 0) stopListening?.()
  }
}

/** The newest version of `id` on the active device that this window has heard of, or null. */
export function useNewestVersion(id: string): number | null {
  return useSyncExternalStore(subscribe, () => newest.get(`${viewsScope()} ${id}`) ?? null)
}

/** One version of a stored view, fetched from the computer that built it. */
export function useStoredView({ id, version }: ViewReference): StoredState {
  const key = formatViewReference({ id, version })
  const [state, setState] = useState<{ key: string; value: StoredState }>({ key: "", value: { status: "loading" } })
  useEffect(() => {
    let current = true
    const scope = viewsScope()
    const settle = (value: StoredState) => { if (current) setState({ key: formatViewReference({ id, version }), value }) }
    authFetch(viewVersionPath({ id, version })).then(async (response) => {
      if (response.status === 404) settle({ status: "missing" })
      else if (!response.ok) settle({ status: "failed" })
      else {
        const view = await response.json() as StoredViewVersion
        rememberNewestVersions(scope, [{ id: view.id, latestVersion: view.latestVersion }])
        settle({ status: "ready", view })
      }
    }).catch(() => settle({ status: "failed" }))
    return () => { current = false }
  }, [id, version])
  return state.key === key ? state.value : { status: "loading" }
}

/** What to show instead of the view when it cannot load; null while it loads or once it has. */
export function storedViewProblem(state: StoredState, whenMissing: string): string | null {
  if (state.status === "missing") return whenMissing
  if (state.status === "failed") return "This view could not load."
  return null
}

/** A built version needs no libraries: its page only waits for the viewer's theme. */
export function storedViewPrepare(view: StoredViewVersion): () => Promise<PreparedView> {
  return async () => ({ libraries: [], compose: (theme) => withViewTheme(view.html, theme) })
}

/** The source files a version was built from. */
export function StoredViewSource({ view, renderCode }: { view: StoredViewVersion; renderCode: (code: string, lang: string) => ReactNode }) {
  return view.files.map((file) => (
    <div key={file.path} className="border-b border-border/70 last:border-b-0">
      <p className="px-3 pt-2 font-mono text-xs text-muted-foreground">{file.path}</p>
      <div className="[&>div]:my-0 [&>div]:rounded-none [&>div]:border-0">{renderCode(file.text, file.path.split(".").pop() ?? "")}</div>
    </div>
  ))
}
