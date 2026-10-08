import { useEffect, useMemo, useSyncExternalStore } from "react"
import { authFetch } from "@/lib/auth"
import { getActiveDeviceScope, getActiveIdentity } from "@/lib/device"
import {
  getModelOptions,
  setDynamicModelOptions,
  subscribeModelOptions,
  resetDynamicModelOptions,
  type ModelOption,
} from "@/lib/utils"
import { AGENT_KINDS, type AgentKind } from "@/lib/agents"

/** A loaded catalog is trusted this long before the next lookup re-asks the server. */
export const CATALOG_TTL_MS = 5 * 60 * 1000
/** A failed load (server still booting, offline) is retried after this long. */
export const CATALOG_RETRY_MS = 30 * 1000

let nextFetchAt = 0
let inFlight: Promise<void> | null = null
let catalogScope = ""
let catalogGeneration = 0
const scopeKey = () => JSON.stringify([getActiveDeviceScope(), getActiveIdentity()])

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
  const generation = catalogGeneration
  const scope = scopeKey()
  try {
    const res = await authFetch("/api/models")
    if (!res.ok) throw new Error(`GET /api/models → ${res.status}`)
    const data = await res.json() as Record<string, unknown> | null
    if (generation !== catalogGeneration || scope !== scopeKey()) return
    for (const kind of AGENT_KINDS) {
      const options = data?.[kind]
      if (isModelOptionArray(options)) setDynamicModelOptions(kind, options)
    }
    nextFetchAt = Date.now() + CATALOG_TTL_MS
  } catch {
    // Offline / server error — static fallback lists stay in effect
    if (generation === catalogGeneration && scope === scopeKey()) nextFetchAt = Date.now() + CATALOG_RETRY_MS
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
  if (catalogScope !== scopeKey()) { resetModelCatalogFetch(); resetDynamicModelOptions(); catalogScope = scopeKey() }
  if (inFlight) return inFlight
  if (Date.now() < nextFetchAt) return Promise.resolve()
  const request = fetchModelCatalog().finally(() => {
    if (inFlight === request) inFlight = null
  })
  inFlight = request
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
  window.addEventListener("cogpit-identity-changed", refresh)
  window.addEventListener("cogpit-device-scope-changed", refresh)
  document.addEventListener("visibilitychange", refresh)
  return () => {
    window.removeEventListener("focus", refresh)
    window.removeEventListener("cogpit-identity-changed", refresh)
    window.removeEventListener("cogpit-device-scope-changed", refresh)
    document.removeEventListener("visibilitychange", refresh)
  }
}

/** Test-only: forget the TTL so the next load fetches again. */
export function resetModelCatalogFetch() {
  catalogGeneration++
  nextFetchAt = 0
  inFlight = null
}

/**
 * Reactive model options for a provider: static fallback list initially,
 * replaced by the live CLI catalog once /api/models responds, and kept current
 * while the app stays open.
 */
export function useModelOptions(agentKind: AgentKind, instanceId = "default"): readonly ModelOption[] {
  const key = JSON.stringify([scopeKey(), agentKind, instanceId])
  const catalog = useMemo(() => instanceCatalogFor(key, agentKind, instanceId), [key, agentKind, instanceId])
  useEffect(() => {
    if (instanceId !== "default") return
    void loadModelCatalog()
    return refreshModelCatalogOnFocus()
  }, [agentKind, instanceId])
  const defaults = useSyncExternalStore(subscribeModelOptions, () => getModelOptions(agentKind))
  const options = useSyncExternalStore(catalog.subscribe, catalog.snapshot)
  return instanceId === "default" ? defaults : options
}

const INSTANCE_DEFAULT_MODELS: readonly ModelOption[] = [{ value: "", label: "Provider default" }]
const instanceCatalogs = new Map<string, InstanceCatalog>()
class InstanceCatalog {
  private options: readonly ModelOption[] = INSTANCE_DEFAULT_MODELS
  private readonly listeners = new Set<() => void>()
  private controller?: AbortController
  private nextFetchAt = 0
  constructor(readonly key: string, readonly agent: AgentKind, readonly instanceId: string, readonly scope: string) {}
  snapshot = () => this.options
  private publish = () => { for (const listener of this.listeners) listener() }
  private invalidate = () => { this.controller?.abort(); this.options = INSTANCE_DEFAULT_MODELS; this.publish(); instanceCatalogs.delete(this.key) }
  private refresh = () => {
    if (this.instanceId === "default" || this.controller || Date.now() < this.nextFetchAt || this.scope !== scopeKey()) return
    const controller = new AbortController(); this.controller = controller
    void authFetch(`/api/models?instanceId=${encodeURIComponent(this.instanceId)}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Model catalog unavailable")
      const data = await response.json() as Record<string, unknown>
      if (controller.signal.aborted || this.scope !== scopeKey()) return
      if (isModelOptionArray(data[this.agent])) { this.options = data[this.agent] as ModelOption[]; this.publish() }
      this.nextFetchAt = Date.now() + CATALOG_TTL_MS
    }).catch(() => { this.nextFetchAt = Date.now() + CATALOG_RETRY_MS }).finally(() => { if (this.controller === controller) this.controller = undefined })
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1 && this.instanceId !== "default") {
      this.refresh()
      window.addEventListener("focus", this.refresh)
      window.addEventListener("cogpit-identity-changed", this.invalidate)
      window.addEventListener("cogpit-device-scope-changed", this.invalidate)
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        this.controller?.abort()
        window.removeEventListener("focus", this.refresh)
        window.removeEventListener("cogpit-identity-changed", this.invalidate)
        window.removeEventListener("cogpit-device-scope-changed", this.invalidate)
        instanceCatalogs.delete(this.key)
      }
    }
  }
}
function instanceCatalogFor(key: string, agent: AgentKind, instanceId: string): InstanceCatalog {
  let catalog = instanceCatalogs.get(key)
  if (!catalog) { catalog = new InstanceCatalog(key, agent, instanceId, scopeKey()); instanceCatalogs.set(key, catalog) }
  return catalog
}
