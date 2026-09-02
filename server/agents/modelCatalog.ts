import type { ModelOption } from "../../shared/session/agent-descriptors"

/**
 * What the live model catalogs share: the timeout every `listModels` runs
 * under, and the effort labels every picker shows.
 */

export type { ModelOption }

export const MODEL_FETCH_TIMEOUT_MS = 20_000

export function effortLabel(effort: string): string {
  switch (effort.toLowerCase()) {
    case "low": return "Light"
    case "xhigh": return "Extra High"
    case "ultra": return "Ultra"
    default: return effort.charAt(0).toUpperCase() + effort.slice(1)
  }
}
