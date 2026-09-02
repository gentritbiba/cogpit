import type { ModelOption } from "@/lib/utils"
import { shortenModel } from "@/lib/format"

export { AGENT_OPTIONS } from "@/lib/agents/presentation"

/**
 * Find the catalog row a model id refers to — an exact value/alias match wins
 * over any row's resolved wire id, so an alias like "best" that resolves to
 * the same model never shadows the explicitly-selected row.
 */
function findModelOption(modelId: string, options?: readonly ModelOption[]): ModelOption | undefined {
  const rows = options?.filter((option) => option.value !== "")
  return rows?.find((option) => option.value === modelId)
    ?? rows?.find((option) => option.resolvedModel === modelId)
}

/**
 * What the provider's "Default" resolves to right now, according to the
 * catalog's own `resolvedModel` data. Plain "Default" when the catalog
 * doesn't say (e.g. offline static fallback) — never a guessed model name.
 */
export function resolveDefaultModelName(options: readonly ModelOption[]): string {
  const resolved = options.find((option) => option.value === "")?.resolvedModel
  return resolved ? friendlyModelName(resolved, options) : "Default"
}

/** Friendly model name for a model id like "claude-opus-4-6", preferring the catalog's own label. */
export function friendlyModelName(modelId: string, options?: readonly ModelOption[]): string {
  return findModelOption(modelId, options)?.label ?? shortenModel(modelId)
}
