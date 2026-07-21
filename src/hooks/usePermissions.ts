import { useState, useCallback, useEffect, useRef } from "react"
import {
  type PermissionsConfig,
  type PermissionMode,
  DEFAULT_PERMISSIONS,
  PERMISSIONS_STORAGE_KEY,
} from "@/lib/permissions"
import { deviceScopedKey } from "@/lib/device"

// Permissions are per-device: the local device keeps the unscoped key; a remote
// device gets its own scoped key. A fresh remote scope has no stored value and
// falls back to explicit DEFAULT_PERMISSIONS — it never inherits the local
// device's stored value.
function storageKey(): string {
  return deviceScopedKey(PERMISSIONS_STORAGE_KEY)
}

function loadFromStorage(): PermissionsConfig {
  try {
    const raw = localStorage.getItem(storageKey())
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PermissionsConfig>
      return {
        mode: (parsed.mode as PermissionMode) || DEFAULT_PERMISSIONS.mode,
        allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
        disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      }
    }
  } catch {
    // corrupted storage
  }
  return DEFAULT_PERMISSIONS
}

function saveToStorage(config: PermissionsConfig): void {
  localStorage.setItem(storageKey(), JSON.stringify(config))
}

export function usePermissions() {
  const [config, setConfig] = useState<PermissionsConfig>(loadFromStorage)
  const [appliedConfig, setAppliedConfig] = useState<PermissionsConfig>(loadFromStorage)
  const isInitial = useRef(true)

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false
      return
    }
    saveToStorage(config)
  }, [config])

  const hasPendingChanges =
    config.mode !== appliedConfig.mode ||
    JSON.stringify(config.allowedTools) !== JSON.stringify(appliedConfig.allowedTools) ||
    JSON.stringify(config.disallowedTools) !== JSON.stringify(appliedConfig.disallowedTools)

  const setMode = useCallback((mode: PermissionMode) => {
    setConfig((prev) => ({ ...prev, mode }))
  }, [])

  const toggleAllowedTool = useCallback((tool: string) => {
    setConfig((prev) => {
      const has = prev.allowedTools.includes(tool)
      return {
        ...prev,
        allowedTools: has
          ? prev.allowedTools.filter((t) => t !== tool)
          : [...prev.allowedTools, tool],
      }
    })
  }, [])

  const toggleDisallowedTool = useCallback((tool: string) => {
    setConfig((prev) => {
      const has = prev.disallowedTools.includes(tool)
      return {
        ...prev,
        disallowedTools: has
          ? prev.disallowedTools.filter((t) => t !== tool)
          : [...prev.disallowedTools, tool],
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
