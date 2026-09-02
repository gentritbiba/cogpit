import { query, type ModelInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { claudeCliPath } from "../sdk-session"
import { effortLabel, MODEL_FETCH_TIMEOUT_MS, type ModelOption } from "./modelCatalog"
import { withTimeout } from "./timeout"

/**
 * Map Claude SDK supportedModels() output to dropdown options, verbatim — the
 * same rows Claude Code's own /model picker renders. The SDK's "default"
 * pseudo-model maps to "" (no --model flag), keeping its CLI-provided
 * displayName/description, and every row carries `resolvedModel` (the
 * canonical wire id it resolves to) so the frontend never has to guess what
 * "Default" actually is.
 */
export function mapClaudeModels(models: ModelInfo[]): ModelOption[] | null {
  if (!Array.isArray(models) || models.length === 0) return null
  const options: ModelOption[] = []
  for (const m of models) {
    if (!m?.value || !m.displayName) continue
    const capabilities: Partial<ModelOption> = {}
    if (typeof m.supportsEffort === "boolean") capabilities.supportsEffort = m.supportsEffort
    if (m.supportedEffortLevels) {
      capabilities.supportedReasoningEfforts = m.supportedEffortLevels.map((effort) => ({
        value: effort,
        label: effortLabel(effort),
      }))
    }
    if (typeof m.supportsAdaptiveThinking === "boolean") {
      capabilities.supportsAdaptiveThinking = m.supportsAdaptiveThinking
    }
    if (typeof m.supportsAutoMode === "boolean") capabilities.supportsAutoMode = m.supportsAutoMode
    if (m.supportsFastMode) {
      capabilities.serviceTiers = [
        { value: "fast", label: "Fast", description: "Lower latency with increased usage" },
      ]
    }
    const isDefault = m.value === "default"
    options.push({
      value: isDefault ? "" : m.value,
      label: m.displayName,
      description: m.description,
      ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
      ...(isDefault ? { isDefault: true } : {}),
      ...capabilities,
    })
  }
  // Ensure a "" Default entry always exists and comes first
  if (!options.some((o) => o.value === "")) {
    options.unshift({ value: "", label: "Default" })
  } else {
    options.sort((a, b) => (a.value === "" ? -1 : b.value === "" ? 1 : 0))
  }
  return options.length > 1 ? options : null
}

/**
 * Ask the Claude Code CLI (via the agent SDK) which models it currently
 * supports. Spawns a short-lived query solely for the supportedModels()
 * control request, then aborts it.
 */
export async function fetchClaudeModels(): Promise<ModelOption[] | null> {
  const abort = new AbortController()
  try {
    const q = query({
      // Never-yielding prompt: we only want the control channel.
      // eslint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await new Promise(() => {})
      })(),
      options: {
        abortController: abort,
        maxTurns: 1,
        pathToClaudeCodeExecutable: claudeCliPath(),
      },
    })
    const models = await withTimeout(q.supportedModels(), MODEL_FETCH_TIMEOUT_MS, "claude supportedModels")
    return mapClaudeModels(models)
  } catch {
    return null
  } finally {
    abort.abort()
  }
}
