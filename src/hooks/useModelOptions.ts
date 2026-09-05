import { useEffect, useSyncExternalStore } from "react"
import { authFetch } from "@/lib/auth"
import {
  getModelOptions,
  setDynamicModelOptions,
  subscribeModelOptions,
  type ModelOption,
} from "@/lib/utils"
import { AGENT_KINDS, type AgentKind } from "@/lib/agents"

/** A loaded catalog is trusted this long before the next lookup re-asks the server. */
export const CATALOG_TTL_MS = 5 * 60 * 1000
/** A failed load (server still booting, offline) is retried after this long. */
export const CATALOG_RETRY_MS = 30 * 1000

let nextFetchAt = 0
let inFlight: Promise<void> | null = null

function isModelOptionArray(value: unknown): value is ModelOption[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (opt) =>
        opt && typeof opt === "object" &&
        typeof (opt as ModelOption).value === "string" &&
        typeof (opt as ModelOption).label === "string",
    )
  )
}

async function fetchModelCatalog(): Promise<void> {
  try {
    const res = await authFetch("/api/models")
    if (!res.ok) throw new Error(`GET /api/models → ${res.status}`)
    const data = await res.json() as Record<string, unknown> | null
    for (const kind of AGENT_KINDS) {
      const options = data?.[kind]
      if (isModelOptionArray(options)) setDynamicModelOptions(kind, options)
    }
    nextFetchAt = Date.now() + CATALOG_TTL_MS
  } catch {
    // Offline / server error — static fallback lists stay in effect
    nextFetchAt = Date.now() + CATALOG_RETRY_MS
  }
}

/**
 * Fetch the live model catalogs from the installed provider CLIs
 * (GET /api/models) and swap them into the shared store. The desktop app stays
 * open for days, so this is a TTL rather than a once-per-page-load latch: a
 * CLI upgraded underneath a running app shows its new models within
 * `CATALOG_TTL_MS`. Any provider that fails keeps its static fallback list.
 */
export function loadModelCatalog(): Promise<void> {
  if (inFlight) return inFlight
  if (Date.now() < nextFetchAt) return Promise.resolve()
  inFlight = fetchModelCatalog().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Re-check the catalog whenever the app comes back to the foreground — the
 * moment a user who upgraded a CLI in a terminal returns to Cogpit.
 * Returns the teardown.
 */
export function refreshModelCatalogOnFocus(): () => void {
  const refresh = () => {
    if (document.visibilityState === "visible") void loadModelCatalog()
  }
  window.addEventListener("focus", refresh)
  document.addEventListener("visibilitychange", refresh)
  return () => {
    window.removeEventListener("focus", refresh)
    document.removeEventListener("visibilitychange", refresh)
  }
}

/** Test-only: forget the TTL so the next load fetches again. */
export function resetModelCatalogFetch() {
  nextFetchAt = 0
  inFlight = null
}

/**
 * Reactive model options for a provider: static fallback list initially,
 * replaced by the live CLI catalog once /api/models responds, and kept current
 * while the app stays open.
 */
export function useModelOptions(agentKind: AgentKind): readonly ModelOption[] {
  useEffect(() => {
    void loadModelCatalog()
    return refreshModelCatalogOnFocus()
  }, [])
  return useSyncExternalStore(subscribeModelOptions, () => getModelOptions(agentKind))
}
