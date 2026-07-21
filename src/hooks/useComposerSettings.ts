import { useCallback, useEffect, useRef, useState } from "react"
import { useModelOptions } from "@/hooks/useModelOptions"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { ParsedSession } from "@/lib/types"
import type { AgentKind } from "@/lib/sessionSource"
import {
  getFastServiceTierOption,
  isUltracodeCapableModel,
  normalizeEffortForAgent,
  supportsImageInput,
} from "@/lib/utils"

interface UseComposerSettingsOptions {
  agentKind: AgentKind | undefined
  session: ParsedSession | null
  sessionSource: SessionSource | null
  pendingDirName: string | null
  isLive: boolean
}

/**
 * Owns the model and execution-mode choices shared by new-session creation,
 * active PTY chat, and the composer settings UI.
 */
export function useComposerSettings({
  agentKind,
  session,
  sessionSource,
  pendingDirName,
  isLive,
}: UseComposerSettingsOptions) {
  const effectiveAgentKind = agentKind ?? "claude"
  const availableModelOptions = useModelOptions(effectiveAgentKind)

  // An empty model or effort delegates to the provider's recommended default.
  const [selectedModel, setSelectedModel] = useState("")
  const [selectedEffort, setSelectedEffort] = useState("")
  const [fastModeEnabled, setFastModeEnabled] = useState(false)
  const [ultracodeEnabled, setUltracodeEnabled] = useState(false)

  const ultracodeAvailable = isUltracodeCapableModel(
    effectiveAgentKind,
    selectedModel || session?.model,
  )
  const ultracodeActive = ultracodeEnabled && ultracodeAvailable
  const effectiveEffort = ultracodeActive
    ? "xhigh"
    : normalizeEffortForAgent(effectiveAgentKind, selectedEffort, selectedModel)
  const fastModeAvailable = !!getFastServiceTierOption(effectiveAgentKind, selectedModel)
  const fastModeActive = fastModeAvailable && fastModeEnabled
  const imageInputAvailable = supportsImageInput(effectiveAgentKind, selectedModel)

  const [modelFallbackNotice, setModelFallbackNotice] = useState<string | null>(null)
  const lastClaudeFallbackRef = useRef<string | null>(null)

  const handleCodexModelRejected = useCallback((rejectedModel: string) => {
    setSelectedModel((current) => current === rejectedModel ? "" : current)
    setModelFallbackNotice(
      `${rejectedModel} is unavailable for this account. Cogpit retried the turn with Codex's default model.`,
    )
  }, [])

  const dismissModelFallbackNotice = useCallback(() => {
    setModelFallbackNotice(null)
  }, [])

  // A model selected for one provider must not leak into an incompatible
  // session after the user changes project or agent.
  useEffect(() => {
    if (!selectedModel) return
    if (!sessionSource && !pendingDirName) return
    if (!availableModelOptions.some((option) => option.value === selectedModel)) {
      setSelectedModel("")
    }
  }, [availableModelOptions, selectedModel, sessionSource, pendingDirName])

  useEffect(() => {
    if (!modelFallbackNotice) return
    const timer = setTimeout(() => setModelFallbackNotice(null), 12_000)
    return () => clearTimeout(timer)
  }, [modelFallbackNotice])

  useEffect(() => {
    if (!isLive || session?.agentKind !== "claude") return
    const rawMessages = session.rawMessages
    let fallback: (typeof rawMessages)[number] | undefined
    for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
      const message = rawMessages[index]
      if (message.type === "system" && message.subtype === "model_refusal_fallback") {
        fallback = message
        break
      }
    }
    if (!fallback) return
    const identity = typeof fallback.uuid === "string"
      ? fallback.uuid
      : `${String(fallback.original_model)}:${String(fallback.fallback_model)}:${String(fallback.request_id)}`
    if (lastClaudeFallbackRef.current === identity) return
    lastClaudeFallbackRef.current = identity
    const original = typeof fallback.original_model === "string" ? fallback.original_model : "Fable"
    const replacement = typeof fallback.fallback_model === "string" ? fallback.fallback_model : "Opus"
    const explanation = typeof fallback.api_refusal_explanation === "string"
      ? ` ${fallback.api_refusal_explanation}`
      : ""
    setModelFallbackNotice(`${original} could not handle this request, so Claude continued with ${replacement}.${explanation}`)
  }, [isLive, session?.agentKind, session?.rawMessages])

  return {
    selectedModel,
    setSelectedModel,
    selectedEffort,
    setSelectedEffort,
    fastModeEnabled,
    ultracodeEnabled,
    effectiveEffort,
    fastModeAvailable,
    fastModeActive,
    setFastModeEnabled,
    ultracodeAvailable,
    ultracodeActive,
    setUltracodeEnabled,
    imageInputAvailable,
    modelFallbackNotice,
    dismissModelFallbackNotice,
    handleCodexModelRejected,
  }
}
