import { Bot, Code2 } from "lucide-react"
import type { ModelOption } from "@/lib/utils"
import type { AgentKind } from "@/lib/sessionSource"

export const AGENT_OPTIONS: Array<{ value: AgentKind; label: string; Icon: typeof Bot }> = [
  { value: "claude", label: "Claude", Icon: Bot },
  { value: "codex", label: "Codex", Icon: Code2 },
]

/** Extract a friendly model name from a model ID like "claude-opus-4-6". */
export function friendlyModelName(modelId: string, options?: readonly ModelOption[]): string {
  const match = options?.find((option) => option.value !== "" && option.value === modelId)
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
