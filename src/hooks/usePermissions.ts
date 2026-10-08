import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { capabilitiesFor, DEFAULT_AGENT_KIND, type AgentKind } from "@/lib/agents"
import { agentPermissionModes } from "@/lib/agents/presentation"
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

function supportedMode(kind: AgentKind, mode: PermissionMode): PermissionMode {
  const modes = agentPermissionModes(kind)
  return (modes.find((option) => option.value === mode) ?? modes[0]!).value as PermissionMode
}

function supportedConfig(kind: AgentKind, config: PermissionsConfig): PermissionsConfig {
  return { ...config, mode: supportedMode(kind, config.mode), ...(!capabilitiesFor(kind).toolPermissionRules && { allowedTools: [], disallowedTools: [] }) }
}

export function usePermissions(agentKind: AgentKind = DEFAULT_AGENT_KIND) {
  const [storedConfig, setConfig] = useState<PermissionsConfig>(loadFromStorage)
  const [appliedConfig, setAppliedConfig] = useState<PermissionsConfig>(loadFromStorage)
  const config = useMemo(() => supportedConfig(agentKind, storedConfig), [storedConfig, agentKind])
  const applied = useMemo(() => supportedConfig(agentKind, appliedConfig), [appliedConfig, agentKind])
  const isInitial = useRef(true)

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false
      return
    }
    saveToStorage(storedConfig)
  }, [storedConfig])

  const hasPendingChanges =
    config.mode !== applied.mode ||
    JSON.stringify(config.allowedTools) !== JSON.stringify(applied.allowedTools) ||
    JSON.stringify(config.disallowedTools) !== JSON.stringify(applied.disallowedTools)

  const setMode = useCallback((mode: PermissionMode) => {
    setConfig((prev) => ({ ...prev, mode: supportedMode(agentKind, mode) }))
  }, [agentKind])

  const markApplied = useCallback(() => {
    setAppliedConfig(config)
  }, [config])

  return {
    config,
    hasPendingChanges,
    setMode,
    markApplied,
  }
}
