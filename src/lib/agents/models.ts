import { descriptorFor, type AgentKind, type EffortOption, type ModelOption, type ServiceTierOption } from "."

/**
 * Static model lists shown until each CLI's live catalog arrives (GET
 * /api/models, see useModelOptions), and instead of it when the CLI is missing
 * or offline. Kept roughly current by hand.
 */

// Aliases accepted by the Claude Code CLI (v2.1.287). Each resolves to a model
// with a 1M window, so the catalog no longer lists separate "[1m]" rows.
const CLAUDE_MODELS: readonly ModelOption[] = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
]

const CODEX_STANDARD_EFFORTS: EffortOption[] = [
  { value: "low", label: "Light", description: "Fast responses with lighter reasoning" },
  { value: "medium", label: "Medium", description: "Balanced for everyday tasks" },
  { value: "high", label: "High", description: "Deeper reasoning for complex work" },
  { value: "xhigh", label: "Extra High", description: "Extra depth for difficult problems" },
  { value: "max", label: "Max", description: "Maximum reasoning depth" },
]
const CODEX_ULTRA_EFFORTS: EffortOption[] = [
  ...CODEX_STANDARD_EFFORTS,
  { value: "ultra", label: "Ultra", description: "Maximum reasoning with automatic task delegation" },
]
const CODEX_XHIGH_EFFORTS: EffortOption[] = CODEX_STANDARD_EFFORTS.slice(0, 4)
const CODEX_FAST_TIER_VALUE = descriptorFor("codex").serviceTier?.appServerValue ?? "priority"
const CODEX_FAST_TIER: ServiceTierOption[] = [
  { value: CODEX_FAST_TIER_VALUE, label: "Fast", description: "1.5× speed with increased usage" },
]
const CODEX_FASTER_TIER: ServiceTierOption[] = [
  { value: CODEX_FAST_TIER_VALUE, label: "Fast", description: "2× speed with increased usage" },
]

const CODEX_CAPABILITIES: Partial<ModelOption> = {
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: CODEX_ULTRA_EFFORTS,
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  serviceTiers: CODEX_FAST_TIER,
}

// Mirrors `model/list` from Codex CLI 0.159.3.
const CODEX_MODELS: readonly ModelOption[] = [
  { value: "", label: "Default", description: "Use the model configured in Codex" },
  { value: "gpt-6.1-sol", label: "GPT-6.1 Sol", description: "Latest workhorse model for coding and everyday work", ...CODEX_CAPABILITIES, defaultReasoningEffort: "low", serviceTiers: CODEX_FASTER_TIER },
  { value: "gpt-6-astra", label: "GPT-6 Astra", description: "Frontier intelligence for the most demanding work", ...CODEX_CAPABILITIES, serviceTiers: CODEX_FASTER_TIER },
  { value: "gpt-6-sol", label: "GPT-6 Sol", description: "Previous generation workhorse model", ...CODEX_CAPABILITIES },
  { value: "gpt-6-luna", label: "GPT-6 Luna", description: "Fast and affordable model for easier tasks", ...CODEX_CAPABILITIES, supportedReasoningEfforts: CODEX_STANDARD_EFFORTS },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "Older generation workhorse model", ...CODEX_CAPABILITIES, defaultReasoningEffort: "low" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "Older balanced model for straightforward work", ...CODEX_CAPABILITIES },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: "Older fast and efficient model", ...CODEX_CAPABILITIES, supportedReasoningEfforts: CODEX_STANDARD_EFFORTS },
  { value: "gpt-5.5", label: "GPT-5.5", description: "Legacy coding model", ...CODEX_CAPABILITIES, supportedReasoningEfforts: CODEX_XHIGH_EFFORTS },
]

const COPILOT_MODELS: readonly ModelOption[] = [
  { value: "", label: "Default", supportsEffort: false, inputModalities: ["text"] },
  {
    value: "auto",
    label: "Auto",
    description: "Let Copilot choose the best available model",
    supportsEffort: false,
    inputModalities: ["text"],
  },
]

const FALLBACK_MODELS: Record<AgentKind, readonly ModelOption[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  copilot: COPILOT_MODELS,
}

export function fallbackModelsFor(kind: AgentKind): readonly ModelOption[] {
  return FALLBACK_MODELS[kind]
}
