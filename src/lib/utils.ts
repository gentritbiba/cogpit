import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { AgentKind } from "./sessionSource"

export type EffortOption = { value: string; label: string; description?: string }

export type ServiceTierOption = { value: string; label: string; description?: string }

export type ModelOption = {
  value: string
  label: string
  description?: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: EffortOption[]
  inputModalities?: string[]
  supportsPersonality?: boolean
  serviceTiers?: ServiceTierOption[]
  availabilityMessage?: string
  supportsEffort?: boolean
  supportsAdaptiveThinking?: boolean
  supportsAutoMode?: boolean
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Model options ────────────────────────────────────────────────────────────
// The lists below are STATIC FALLBACKS only. At runtime the app fetches the
// live model catalogs from the installed claude/codex CLIs via GET /api/models
// (see useModelOptions) and swaps them in, so new models appear without a
// Cogpit release. Keep the fallbacks roughly current anyway for offline/error
// paths.

// Aliases accepted by the Claude Code CLI (v2.1.172):
// sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
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
  { value: "priority", label: "Fast", description: "1.5× speed with increased usage" },
]

const SOL_CAPABILITIES: Partial<ModelOption> = {
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: CODEX_ULTRA_EFFORTS,
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  serviceTiers: CODEX_FAST_TIER,
}

export const CODEX_MODEL_OPTIONS: ModelOption[] = [
  { value: "", label: "Default", description: "Use Codex's recommended model (GPT-5.6 Sol)", ...SOL_CAPABILITIES },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "Flagship model for the most ambitious work", ...SOL_CAPABILITIES },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "Balanced model for everyday work", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_ULTRA_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: false, serviceTiers: CODEX_FAST_TIER },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: "Fastest, most cost-efficient model", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_STANDARD_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: false, serviceTiers: CODEX_FAST_TIER },
  { value: "gpt-5.5", label: "GPT-5.5", description: "Frontier model for complex real-world work", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_XHIGH_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: true, serviceTiers: CODEX_FAST_TIER },
  { value: "gpt-5.4", label: "GPT-5.4", description: "Strong model for everyday coding", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_XHIGH_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: true, serviceTiers: CODEX_FAST_TIER },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "Small, fast model for simpler tasks", defaultReasoningEffort: "medium", supportedReasoningEfforts: CODEX_XHIGH_EFFORTS, inputModalities: ["text", "image"], supportsPersonality: true },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", description: "Ultra-fast text-only coding model", defaultReasoningEffort: "high", supportedReasoningEfforts: CODEX_XHIGH_EFFORTS, inputModalities: ["text"], supportsPersonality: true },
]

// Live catalogs fetched from the CLIs (null = not loaded, use static fallback)
const dynamicModelOptions: Record<AgentKind, ModelOption[] | null> = {
  claude: null,
  codex: null,
}
const modelOptionListeners = new Set<() => void>()

/** Replace the model list for a provider with a live catalog from its CLI. */
export function setDynamicModelOptions(agentKind: AgentKind, options: ModelOption[]) {
  if (!Array.isArray(options) || options.length === 0) return
  dynamicModelOptions[agentKind] = options
  modelOptionListeners.forEach((listener) => listener())
}

/** Subscribe to model-list changes (for useSyncExternalStore). */
export function subscribeModelOptions(listener: () => void): () => void {
  modelOptionListeners.add(listener)
  return () => modelOptionListeners.delete(listener)
}

/** Test-only: reset dynamic catalogs back to the static fallbacks. */
export function resetDynamicModelOptions() {
  dynamicModelOptions.claude = null
  dynamicModelOptions.codex = null
  modelOptionListeners.forEach((listener) => listener())
}

const DEFAULT_EFFORT = "high"

// Claude Code CLI (v2.1.111+) and Codex both support xhigh effort.
const EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: "low", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
]

export function getModelOptions(agentKind: AgentKind): readonly ModelOption[] {
  return (
    dynamicModelOptions[agentKind] ??
    (agentKind === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS)
  )
}

export function getSelectedModelOption(agentKind: AgentKind, model?: string | null): ModelOption | undefined {
  const options = getModelOptions(agentKind)
  if (model) return options.find((option) => option.value === model)
  return options.find((option) => option.value !== "" && option.isDefault)
    ?? options.find((option) => option.value === "")
    ?? options.find((option) => option.value !== "")
}

export function getEffortOptions(agentKind: AgentKind, model?: string | null): readonly EffortOption[] {
  const selected = getSelectedModelOption(agentKind, model)
  const supported = selected?.supportedReasoningEfforts
  if (supported && supported.length > 0) return supported
  if (selected?.supportsEffort === false) return []
  return EFFORT_OPTIONS
}

export function getServiceTierOptions(agentKind: AgentKind, model?: string | null): readonly ServiceTierOption[] {
  return getSelectedModelOption(agentKind, model)?.serviceTiers ?? []
}

export function getFastServiceTierOption(agentKind: AgentKind, model?: string | null): ServiceTierOption | undefined {
  return getServiceTierOptions(agentKind, model).find(
    (tier) => tier.value === "fast" || tier.value === "priority" || tier.label.toLowerCase() === "fast",
  )
}

export function supportsImageInput(agentKind: AgentKind, model?: string | null): boolean {
  const modalities = getSelectedModelOption(agentKind, model)?.inputModalities
  return !modalities || modalities.includes("image")
}

export function supportsAutoPermissionMode(agentKind: AgentKind, model?: string | null): boolean {
  return agentKind === "claude" && getSelectedModelOption(agentKind, model)?.supportsAutoMode === true
}

/**
 * Whether a Claude model can run "ultracode" (which requires xhigh effort).
 * Haiku doesn't support high-effort levels; every other Claude alias — including
 * the empty "Default" (Opus) — does. Codex has no ultracode concept.
 */
export function isUltracodeCapableModel(agentKind: AgentKind, model?: string | null): boolean {
  if (agentKind !== "claude") return false
  return !(model ?? "").toLowerCase().startsWith("haiku")
}

export function normalizeEffortForAgent(agentKind: AgentKind, effort?: string | null, model?: string | null): string {
  const options = getEffortOptions(agentKind, model)
  if (options.length === 0) return ""
  const modelDefault = getSelectedModelOption(agentKind, model)?.defaultReasoningEffort
  const fallback = modelDefault && options.some((option) => option.value === modelDefault)
    ? modelDefault
    : options.some((option) => option.value === DEFAULT_EFFORT)
      ? DEFAULT_EFFORT
      : options[0]?.value ?? DEFAULT_EFFORT
  const normalized = effort || fallback
  return options.some((option) => option.value === normalized) ? normalized : fallback
}

/** Convert a user message into a valid worktree/branch name. */
export function slugifyWorktreeName(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "")
}

/** Copy text to clipboard with fallback for Electron/sandboxed contexts. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback: execCommand('copy') via a temporary textarea
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(textarea)
    return ok
  }
}
