import { Bot, Code2, Github } from "lucide-react"
import type { ModelOption } from "@/lib/utils"
import type { AgentKind } from "@/lib/sessionSource"

export const AGENT_OPTIONS: Array<{ value: AgentKind; label: string; Icon: typeof Bot }> = [
  { value: "claude", label: "Claude", Icon: Bot },
  { value: "codex", label: "Codex", Icon: Code2 },
  { value: "copilot", label: "Copilot", Icon: Github },
]

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

/** Extract a friendly model name from a model ID like "claude-opus-4-6". */
export function friendlyModelName(modelId: string, options?: readonly ModelOption[]): string {
  const match = findModelOption(modelId, options)
  if (match) return match.label

  const lower = modelId.toLowerCase()
  if (lower.includes("opus")) return "Opus"
  if (lower.includes("sonnet")) return "Sonnet"
  if (lower.includes("haiku")) return "Haiku"
  if (lower.includes("fable")) return "Fable"
  if (lower.startsWith("gpt-")) {
    const [version, ...rest] = lower.slice(4).split("-")
    const suffix = rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
    return `GPT-${version}${suffix ? ` ${suffix}` : ""}`
  }
  return modelId
}
