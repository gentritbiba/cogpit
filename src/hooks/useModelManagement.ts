import { useState, useEffect, useRef, useCallback } from "react"
import { authFetch } from "@/lib/auth"

interface UseModelManagementParams {
  currentSessionId: string | null
  hasPendingPermChanges: boolean
  markPermApplied: () => void
}

export function useModelManagement({
  currentSessionId,
  hasPendingPermChanges,
  markPermApplied,
}: UseModelManagementParams) {
  const [selectedModel, setSelectedModel] = useState("")
  const [appliedModels, setAppliedModels] = useState<Record<string, string>>({})
  const selectedModelRef = useRef(selectedModel)
  useEffect(() => {
    selectedModelRef.current = selectedModel
  }, [selectedModel])

  // When session changes: record baseline for new sessions, restore model for revisits
  const prevSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (currentSessionId === prevSessionIdRef.current) return
    prevSessionIdRef.current = currentSessionId
    if (!currentSessionId) return
    setAppliedModels((prev) => {
      if (currentSessionId in prev) {
        setSelectedModel(prev[currentSessionId])
        return prev
      }
      return { ...prev, [currentSessionId]: selectedModelRef.current }
    })
  }, [currentSessionId])

  // Detect if model or permissions have changed from what the persistent process uses
  const hasSettingsChanges =
    currentSessionId != null &&
    currentSessionId in appliedModels &&
    (selectedModel !== appliedModels[currentSessionId] || hasPendingPermChanges)

  // Restart the persistent process to apply new model/permissions
  const handleApplySettings = useCallback(async () => {
    if (!currentSessionId) return
    await authFetch("/api/stop-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId }),
    })
    setAppliedModels((prev) => ({ ...prev, [currentSessionId]: selectedModel }))
    markPermApplied()
  }, [currentSessionId, selectedModel, markPermApplied])

  return {
    selectedModel,
    setSelectedModel,
    hasSettingsChanges,
    handleApplySettings,
  }
}
