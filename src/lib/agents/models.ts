import { descriptorFor, type AgentKind, type EffortOption, type ModelOption, type ServiceTierOption } from "."

/**
 * Static model lists shown until each CLI's live catalog arrives (GET
 * /api/models, see useModelOptions), and instead of it when the CLI is missing
 * or offline. Kept roughly current by hand.
 */

// Aliases accepted by the Claude Code CLI (v2.1.172):
// sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan
const CLAUDE_MODELS: readonly ModelOption[] = [
  { value: "", label: "Default" },
  { value: "fable", label: "Fable" },
  { value: "fable[1m]", label: "Fable 1M" },
  { value: "opus", label: "Opus" },
  { value: "opus[1m]", label: "Opus 1M" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet 1M" },
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
const CODEX_FAST_TIER: ServiceTierOption[] = [
  {
    value: descriptorFor("codex").serviceTier?.appServerValue ?? "priority",
    label: "Fast",
    description: "1.5× speed with increased usage",
  },
]

const SOL_CAPABILITIES: Partial<ModelOption> = {
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: CODEX_ULTRA_EFFORTS,
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  serviceTiers: CODEX_FAST_TIER,
}

const CODEX_MODELS: readonly ModelOption[] = [
  { value: "", label: "Default", description: "Use Codex's recommended model (GPT-5.6 Sol)", resolvedModel: "gpt-5.6-sol", ...SOL_CAPABILITIES },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "Flagship model for the most ambitious work", ...SOL_CAPABILITIES },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "Balanced model for everyday work", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_ULTRA_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: false, serviceTiers: CODEX_FAST_TIER },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: "Fastest, most cost-efficient model", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_STANDARD_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: false, serviceTiers: CODEX_FAST_TIER },
  { value: "gpt-5.5", label: "GPT-5.5", description: "Frontier model for complex real-world work", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_XHIGH_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: true, serviceTiers: CODEX_FAST_TIER },
  { value: "gpt-5.4", label: "GPT-5.4", description: "Strong model for everyday coding", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_XHIGH_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: true, serviceTiers: CODEX_FAST_TIER },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "Small, fast model for simpler tasks", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_XHIGH_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: true },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", description: "Ultra-fast text-only coding model", defaultReasoningEffort: "high", supportedReasoningEfforts: CODEX_XHIGH_EFFORTS, inputModalities: ["text"], supportsPersonality: true },
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
