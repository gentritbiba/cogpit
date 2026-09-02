import { copilotRuntime as transport, type CopilotModel } from "./copilotTransport"
import { effortLabel, MODEL_FETCH_TIMEOUT_MS, type ModelOption } from "./modelCatalog"
import { withTimeout } from "./timeout"

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Map Copilot CLI `models.list` output without depending on its bundled SDK. */
export function mapCopilotModels(models: CopilotModel[]): ModelOption[] | null {
  if (!Array.isArray(models) || models.length === 0) return null
  const mapped = models.flatMap((model): ModelOption[] => {
    if (!model || typeof model.id !== "string" || !model.id) return []
    const policy = record(model.policy)
    if (policy?.state === "disabled") return []
    const capabilities = record(model.capabilities)
    const supports = record(capabilities?.supports)
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.filter((effort): effort is string => typeof effort === "string")
      : []
    return [{
      value: model.id,
      label: typeof model.name === "string" && model.name ? model.name : model.id,
      ...(typeof model.defaultReasoningEffort === "string"
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {}),
      supportedReasoningEfforts: efforts.map((effort) => ({
        value: effort,
        label: effortLabel(effort),
      })),
      supportsEffort: supports?.reasoningEffort === true || efforts.length > 0,
      inputModalities: supports?.vision === true ? ["text", "image"] : ["text"],
    }]
  })
  if (mapped.length === 0) return null
  const providerDefault = mapped.find((model) => model.value === "auto") ?? mapped[0]
  return [{
    ...providerDefault,
    value: "",
    label: "Default",
    resolvedModel: providerDefault.value,
    isDefault: true,
    description: providerDefault.value === "auto"
      ? "Let Copilot choose the best available model"
      : `Use Copilot's default model (${providerDefault.label})`,
  }, ...mapped]
}

export async function fetchCopilotModels(): Promise<ModelOption[] | null> {
  try {
    return mapCopilotModels(await withTimeout(
      transport.listModels(),
      MODEL_FETCH_TIMEOUT_MS,
      "copilot models.list",
    ))
  } catch {
    return null
  }
}
