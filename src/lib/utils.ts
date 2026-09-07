import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import {
  capabilitiesFor,
  type AgentKind,
  type EffortOption,
  type ModelOption,
  type ServiceTierOption,
} from "./agents"
import { fallbackModelsFor } from "./agents/models"

export type { EffortOption, ModelOption, ServiceTierOption }

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Model options ────────────────────────────────────────────────────────────
// Static fallback lists live in ./agents/models. At runtime the app fetches the
// live model catalogs from the installed CLIs via GET /api/models (see
// useModelOptions) and swaps them in, so new models appear without a release.

// Live catalogs fetched from the CLIs; an agent without one uses its fallback.
const dynamicModelOptions = new Map<AgentKind, ModelOption[]>()
const modelOptionListeners = new Set<() => void>()

/** Replace the model list for an agent with a live catalog from its CLI. */
export function setDynamicModelOptions(agentKind: AgentKind, options: ModelOption[]) {
  if (!Array.isArray(options) || options.length === 0) return
  dynamicModelOptions.set(agentKind, options)
  modelOptionListeners.forEach((listener) => listener())
}

/** Subscribe to model-list changes (for useSyncExternalStore). */
export function subscribeModelOptions(listener: () => void): () => void {
  modelOptionListeners.add(listener)
  return () => modelOptionListeners.delete(listener)
}

/** Test-only: reset dynamic catalogs back to the static fallbacks. */
export function resetDynamicModelOptions() {
  dynamicModelOptions.clear()
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
  return dynamicModelOptions.get(agentKind) ?? fallbackModelsFor(agentKind)
}

// ── Catalog-derived facts ────────────────────────────────────────────────────
// Every helper below takes the catalog it reads as an argument instead of
// reaching into the store above. Components are compiled with the React
// Compiler, which memoises a call on its arguments alone; a helper that read
// the store behind the compiler's back would keep returning the static
// fallback after the live catalog arrived. Use `useModelCapabilities` from a
// component.

export function selectModelOption(options: readonly ModelOption[], model?: string | null): ModelOption | undefined {
  if (model) return options.find((option) => option.value === model)
  return options.find((option) => option.value !== "" && option.isDefault)
    ?? options.find((option) => option.value === "")
    ?? options.find((option) => option.value !== "")
}

export function getEffortOptions(
  agentKind: AgentKind,
  options: readonly ModelOption[],
  model?: string | null,
): readonly EffortOption[] {
  const selected = selectModelOption(options, model)
  const supported = selected?.supportedReasoningEfforts
  if (supported && supported.length > 0) return supported
  // Agents without a default effort ladder only offer what their catalog
  // advertises, so a silent catalog means no effort chip at all.
  if (selected?.supportsEffort === false || !capabilitiesFor(agentKind).reasoningEffort) return []
  return EFFORT_OPTIONS
}

export function getFastServiceTierOption(
  options: readonly ModelOption[],
  model?: string | null,
): ServiceTierOption | undefined {
  return selectModelOption(options, model)?.serviceTiers?.find(
    (tier) => tier.value === "fast" || tier.value === "priority" || tier.label.toLowerCase() === "fast",
  )
}

export function supportsImageInput(
  agentKind: AgentKind,
  options: readonly ModelOption[],
  model?: string | null,
): boolean {
  const modalities = selectModelOption(options, model)?.inputModalities
  // A catalog that lists modalities is authoritative either way; the capability
  // only decides what an unannotated model means.
  if (modalities) return modalities.includes("image")
  return capabilitiesFor(agentKind).imageInput
}

export function supportsAutoPermissionMode(
  agentKind: AgentKind,
  options: readonly ModelOption[],
  model?: string | null,
): boolean {
  const mode = capabilitiesFor(agentKind).autoPermissionMode
  if (mode === "always") return true
  if (mode === "never") return false
  return selectModelOption(options, model)?.supportsAutoMode === true
}

/**
 * Whether the selected model can run "ultracode", which pins effort to xhigh.
 * Only the haiku family lacks the high-effort levels it needs, so every other
 * selection — including the empty "Default" — qualifies.
 */
export function isUltracodeCapableModel(agentKind: AgentKind, model?: string | null): boolean {
  if (!capabilitiesFor(agentKind).ultracode) return false
  return !(model ?? "").toLowerCase().startsWith("haiku")
}

export function normalizeEffortForAgent(
  agentKind: AgentKind,
  options: readonly ModelOption[],
  effort?: string | null,
  model?: string | null,
): string {
  const effortOptions = getEffortOptions(agentKind, options, model)
  if (effortOptions.length === 0) return ""
  const offers = (value?: string | null): value is string =>
    !!value && effortOptions.some((option) => option.value === value)

  if (offers(effort)) return effort
  const modelDefault = selectModelOption(options, model)?.defaultReasoningEffort
  if (offers(modelDefault)) return modelDefault
  if (offers(DEFAULT_EFFORT)) return DEFAULT_EFFORT
  return effortOptions[0].value
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
