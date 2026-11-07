import { splitInstanceDirName } from "../../shared/session/instances"
import { useCallback, useEffect, useRef, useState } from "react"
import { useModelCapabilities } from "@/hooks/useModelCapabilities"
import type { SessionSource } from "@/lib/sessionSource"
import type { SessionView } from "../../shared/session/sessionDigest"
import { capabilitiesFor, DEFAULT_AGENT_KIND, type AgentKind, descriptorFor } from "@/lib/agents"
import { isUltracodeCapableModel } from "@/lib/utils"

interface UseComposerSettingsOptions {
  agentKind: AgentKind | undefined
  session: SessionView | null
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
  const effectiveAgentKind = agentKind ?? DEFAULT_AGENT_KIND

  // An empty model or effort delegates to the provider's recommended default.
  const [selectedModel, setSelectedModel] = useState("")
  const [selectedEffort, setSelectedEffort] = useState("")
  const [contextWindowTokens, setContextWindowTokens] = useState<number | null>(null)
  const [fastModeEnabled, setFastModeEnabled] = useState(false)
  const [ultracodeEnabled, setUltracodeEnabled] = useState(false)

  const {
    options: availableModelOptions,
    fastTier,
    imageInput: imageInputAvailable,
    normalizeEffort,
  } = useModelCapabilities(effectiveAgentKind, selectedModel, splitInstanceDirName(sessionSource?.dirName ?? pendingDirName).instanceId)
  const ultracodeAvailable = isUltracodeCapableModel(
    effectiveAgentKind,
    selectedModel || session?.model,
  )
  const ultracodeActive = ultracodeEnabled && ultracodeAvailable
  const effectiveEffort = normalizeEffort(selectedEffort)
  const fastModeAvailable = !!fastTier
  const fastModeActive = fastModeAvailable && fastModeEnabled

  const [modelFallbackNotice, setModelFallbackNotice] = useState<string | null>(null)
  const lastFallbackRef = useRef<string | null>(null)

  // Ultracode is expensive, so it never rides along: opening another session or
  // starting a new one turns it back off, and only an explicit click (or the
  // opened session's own stored config, applied after this reset) enables it.
  const sessionKey = sessionSource?.fileName ?? null
  const previousSessionKeyRef = useRef(sessionKey)
  useEffect(() => {
    const previous = previousSessionKeyRef.current
    previousSessionKeyRef.current = sessionKey
    // A null predecessor means the composed session just became real — keep the
    // toggle the user set while writing that first message.
    if (previous === null || previous === sessionKey) return
    setUltracodeEnabled(false)
    setContextWindowTokens(null)
  }, [sessionKey])

  useEffect(() => {
    if (!pendingDirName) return
    setUltracodeEnabled(false)
    setContextWindowTokens(null)
  }, [pendingDirName])

  const handleModelRejected = useCallback((rejectedModel: string) => {
    setSelectedModel((current) => current === rejectedModel ? "" : current)
    setModelFallbackNotice(
      `${rejectedModel} is unavailable for this account. Cogpit retried the turn with ${descriptorFor(effectiveAgentKind).displayName}'s default model.`,
    )
  }, [effectiveAgentKind])

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

  const fallback = session?.digest.modelFallback ?? null
  useEffect(() => {
    if (!isLive || !fallback) return
    if (!capabilitiesFor(effectiveAgentKind).modelFallbackNotices) return
    if (lastFallbackRef.current === fallback.id) return
    lastFallbackRef.current = fallback.id
    const original = fallback.originalModel ?? "Fable"
    const replacement = fallback.fallbackModel ?? "Opus"
    const explanation = fallback.explanation ? ` ${fallback.explanation}` : ""
    setModelFallbackNotice(`${original} could not handle this request, so Claude continued with ${replacement}.${explanation}`)
  }, [isLive, fallback, effectiveAgentKind])

  return {
    contextWindowTokens,
    setContextWindowTokens,
    contextWindowAvailable: capabilitiesFor(effectiveAgentKind).configurableContextWindow,
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
    handleModelRejected,
  }
}
