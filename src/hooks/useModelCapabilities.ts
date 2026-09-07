import { useModelOptions } from "@/hooks/useModelOptions"
import type { AgentKind } from "@/lib/agents"
import {
  getEffortOptions,
  getFastServiceTierOption,
  normalizeEffortForAgent,
  supportsAutoPermissionMode,
  supportsImageInput,
  type EffortOption,
  type ModelOption,
  type ServiceTierOption,
} from "@/lib/utils"

export interface ModelCapabilities {
  /** The live catalog these facts were read from. */
  options: readonly ModelOption[]
  effortOptions: readonly EffortOption[]
  fastTier: ServiceTierOption | undefined
  imageInput: boolean
  autoPermissionMode: boolean
  /** `effort` clamped to what the model offers, or "" when it offers nothing. */
  normalizeEffort: (effort: string | null | undefined) => string
}

/**
 * What the selected model can do, derived from the live catalog so the
 * answer changes when the catalog does. Read these from here rather than
 * calling the helpers with a store lookup: the React Compiler memoises on
 * arguments, and the catalog has to be one of them.
 */
export function useModelCapabilities(agentKind: AgentKind, model: string | null | undefined): ModelCapabilities {
  const options = useModelOptions(agentKind)
  return {
    options,
    effortOptions: getEffortOptions(agentKind, options, model),
    fastTier: getFastServiceTierOption(options, model),
    imageInput: supportsImageInput(agentKind, options, model),
    autoPermissionMode: supportsAutoPermissionMode(agentKind, options, model),
    normalizeEffort: (effort) => normalizeEffortForAgent(agentKind, options, effort, model),
  }
}
