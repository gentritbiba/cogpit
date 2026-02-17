import { useState, useCallback, useEffect, useRef } from "react"
import {
  type PermissionsConfig,
  type PermissionMode,
  DEFAULT_PERMISSIONS,
  PERMISSIONS_STORAGE_KEY,
} from "@/lib/permissions"

function loadFromStorage(): PermissionsConfig {
  try {
    const raw = localStorage.getItem(PERMISSIONS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.mode === "string") {
        return {
          mode: parsed.mode,
          allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
          disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
        }
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_PERMISSIONS
}

export function usePermissions() {
  const [config, setConfig] = useState<PermissionsConfig>(loadFromStorage)
  const [appliedConfig, setAppliedConfig] = useState<PermissionsConfig>(loadFromStorage)
  const isInitial = useRef(true)

  // Persist to localStorage on every config change
  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false
      return
    }
    localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify(config))
  }, [config])

  const hasPendingChanges = JSON.stringify(config) !== JSON.stringify(appliedConfig)

  const setMode = useCallback((mode: PermissionMode) => {
    setConfig((prev) => ({ ...prev, mode }))
  }, [])

  const toggleAllowedTool = useCallback((tool: string) => {
    setConfig((prev) => {
      const isAllowed = prev.allowedTools.includes(tool)
      if (isAllowed) {
        return { ...prev, allowedTools: prev.allowedTools.filter((t) => t !== tool) }
      }
      return {
        ...prev,
        allowedTools: [...prev.allowedTools, tool],
        disallowedTools: prev.disallowedTools.filter((t) => t !== tool),
      }
    })
  }, [])

  const toggleDisallowedTool = useCallback((tool: string) => {
    setConfig((prev) => {
      const isDisallowed = prev.disallowedTools.includes(tool)
      if (isDisallowed) {
        return { ...prev, disallowedTools: prev.disallowedTools.filter((t) => t !== tool) }
      }
      return {
        ...prev,
        disallowedTools: [...prev.disallowedTools, tool],
        allowedTools: prev.allowedTools.filter((t) => t !== tool),
      }
    })
  }, [])

  const markApplied = useCallback(() => {
    setAppliedConfig(config)
  }, [config])

  const resetToDefault = useCallback(() => {
    setConfig(DEFAULT_PERMISSIONS)
  }, [])

  return {
    config,
    appliedConfig,
    hasPendingChanges,
    setMode,
    toggleAllowedTool,
    toggleDisallowedTool,
    markApplied,
    resetToDefault,
  }
}
