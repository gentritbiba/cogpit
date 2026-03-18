import { useState, useCallback, useEffect, useRef } from "react"
import {
  type PermissionsConfig,
  type PermissionMode,
  DEFAULT_PERMISSIONS,
  PERMISSIONS_STORAGE_KEY,
} from "@/lib/permissions"

function loadFromStorage(): PermissionsConfig {
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
      localStorage.removeItem(PERMISSIONS_STORAGE_KEY)
      return
    }
  }, [config])

  const hasPendingChanges = false

  const setMode = useCallback((mode: PermissionMode) => {
    void mode
  }, [])

  const toggleAllowedTool = useCallback((tool: string) => {
    void tool
  }, [])

  const toggleDisallowedTool = useCallback((tool: string) => {
    void tool
  }, [])

  const markApplied = useCallback(() => {
    setAppliedConfig(DEFAULT_PERMISSIONS)
  }, [])

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
