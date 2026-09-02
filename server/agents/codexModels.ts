import { codexAppServer } from "./codexAppServer"
import { effortLabel, MODEL_FETCH_TIMEOUT_MS, type ModelOption } from "./modelCatalog"
import { withTimeout } from "./timeout"

/** Shape of one entry returned by codex app-server `model/list`. */
export interface CodexModel {
  id: string
  model: string
  displayName: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    description?: string
  }>
  inputModalities?: string[]
  supportsPersonality?: boolean
  additionalSpeedTiers?: string[]
  serviceTiers?: Array<{
    id: string
    name: string
    description?: string
  }>
  availabilityNux?: { message?: string } | null
}

/**
 * Codex display names use dashes throughout ("GPT-5.6-Sol") — match our
 * existing "GPT-5.4 Mini" style by turning only the suffix dashes into spaces.
 */
function prettifyCodexLabel(name: string): string {
  const match = name.match(/^(GPT-[\d.]+)(.*)$/i)
  if (!match) return name
  return match[1] + match[2].replace(/-/g, " ")
}

function mapCodexModel(model: CodexModel): ModelOption {
  const serviceTiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.map((tier) => ({
        value: tier.id,
        label: tier.name,
        description: tier.description,
      }))
    : []

  // Older catalogs advertised speed tiers separately. Preserve that signal so
  // the frontend can still offer Fast mode when it talks to an older CLI.
  for (const tier of model.additionalSpeedTiers ?? []) {
    if (!serviceTiers.some((option) => option.value === tier || option.label.toLowerCase() === tier.toLowerCase())) {
      serviceTiers.push({
        value: tier,
        label: effortLabel(tier),
        description: tier === "fast" ? "Higher throughput with increased usage" : undefined,
      })
    }
  }

  return {
    value: model.model,
    label: prettifyCodexLabel(model.displayName),
    description: model.description,
    isDefault: !!model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((effort) => ({
      value: effort.reasoningEffort,
      label: effortLabel(effort.reasoningEffort),
      description: effort.description,
    })),
    inputModalities: model.inputModalities,
    supportsPersonality: model.supportsPersonality,
    serviceTiers,
    availabilityMessage: model.availabilityNux?.message,
    supportsEffort: (model.supportedReasoningEfforts?.length ?? 0) > 0,
  }
}

/** Map codex `model/list` output to dropdown options ("" = codex default). */
export function mapCodexModels(models: CodexModel[]): ModelOption[] | null {
  if (!Array.isArray(models) || models.length === 0) return null
  const visible = models.filter((m) => m && !m.hidden && m.model && m.displayName)
  if (visible.length === 0) return null
  // Default model first, right after the "" Default entry
  visible.sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false))
  const mapped = visible.map(mapCodexModel)
  const providerDefault = mapped.find((model) => model.isDefault) ?? mapped[0]
  return [
    {
      ...providerDefault,
      value: "",
      label: "Default",
      resolvedModel: providerDefault.value,
      description: `Use Codex's recommended model (${providerDefault.label})`,
    },
    ...mapped,
  ]
}

/**
 * Ask the shared Codex app-server which models it currently offers. Reusing
 * the product's long-lived transport avoids spawning a second CLI and keeps
 * protocol initialization/capability negotiation in one place.
 */
export async function fetchCodexModels(): Promise<ModelOption[] | null> {
  try {
    const result = await withTimeout(
      codexAppServer.call<{ data?: CodexModel[] }>("model/list", { includeHidden: false }),
      MODEL_FETCH_TIMEOUT_MS,
      "codex model/list",
    )
    return mapCodexModels(result.data ?? [])
  } catch {
    return null
  }
}
