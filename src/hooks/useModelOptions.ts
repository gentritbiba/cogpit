import { useEffect, useSyncExternalStore } from "react"
import { authFetch } from "@/lib/auth"
import {
  getModelOptions,
  setDynamicModelOptions,
  subscribeModelOptions,
  type ModelOption,
} from "@/lib/utils"
import type { AgentKind } from "@/lib/sessionSource"

let fetchStarted = false

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

/**
 * Fetch the live model catalogs from the installed claude/codex CLIs
 * (GET /api/models) and swap them into the shared store. Runs once per page
 * load; any provider that fails keeps its static fallback list.
 */
export async function loadModelCatalog(): Promise<void> {
  if (fetchStarted) return
  fetchStarted = true
  try {
    const res = await authFetch("/api/models")
    if (!res.ok) return
    const data = await res.json()
    if (isModelOptionArray(data?.claude)) setDynamicModelOptions("claude", data.claude)
    if (isModelOptionArray(data?.codex)) setDynamicModelOptions("codex", data.codex)
  } catch {
    // Offline / server error — static fallback lists stay in effect
  }
}

/** Test-only: allow re-fetching after resetDynamicModelOptions(). */
export function resetModelCatalogFetch() {
  fetchStarted = false
}

/**
 * Reactive model options for a provider: static fallback list initially,
 * replaced by the live CLI catalog once /api/models responds.
 */
export function useModelOptions(agentKind: AgentKind): readonly ModelOption[] {
  useEffect(() => {
    void loadModelCatalog()
  }, [])
  return useSyncExternalStore(subscribeModelOptions, () => getModelOptions(agentKind))
}
