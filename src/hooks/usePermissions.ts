import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { capabilitiesFor, DEFAULT_AGENT_KIND, type AgentKind } from "@/lib/agents"
import { agentPermissionModes } from "@/lib/agents/presentation"
import {
  type PermissionsConfig,
  type PermissionMode,
  defaultPermissions,
  PERMISSIONS_STORAGE_KEY,
} from "@/lib/permissions"
import { deviceScopedKey } from "@/lib/device"

// Permissions are per-device: the local device keeps the unscoped key; a remote
// device gets its own scoped key. A fresh remote scope has no stored value and
// falls back to that device's defaults — it never inherits the local device's
// stored value.
function storageKey(): string {
  return deviceScopedKey(PERMISSIONS_STORAGE_KEY)
}

/** The stored choice, or null while nobody on this device has made one. */
function loadFromStorage(): PermissionsConfig | null {
  try {
    const raw = localStorage.getItem(storageKey())
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PermissionsConfig>
      if (!parsed.mode) return null
      return {
        mode: parsed.mode as PermissionMode,
        allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
        disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      }
    }
  } catch {
    // corrupted storage
  }
  return null
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

/**
 * The access picker's value. Until the user picks a mode on this device it
 * follows the server's install: ask first on a new one, Full access on one
 * from before (see {@link defaultPermissions}).
 */
export function usePermissions(agentKind: AgentKind = DEFAULT_AGENT_KIND, freshInstall = false) {
  const [storedConfig, setConfig] = useState<PermissionsConfig | null>(loadFromStorage)
  const [appliedConfig, setAppliedConfig] = useState<PermissionsConfig | null>(loadFromStorage)
  const fallback = useMemo(() => defaultPermissions(freshInstall), [freshInstall])
  const config = useMemo(() => supportedConfig(agentKind, storedConfig ?? fallback), [storedConfig, fallback, agentKind])
  const applied = useMemo(() => supportedConfig(agentKind, appliedConfig ?? fallback), [appliedConfig, fallback, agentKind])
  const isInitial = useRef(true)

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false
      return
    }
    if (storedConfig) saveToStorage(storedConfig)
  }, [storedConfig])

  const hasPendingChanges =
    config.mode !== applied.mode ||
    JSON.stringify(config.allowedTools) !== JSON.stringify(applied.allowedTools) ||
    JSON.stringify(config.disallowedTools) !== JSON.stringify(applied.disallowedTools)

  /** The mode a session of `kind` starts with, for a composer whose agent is not the open session's. */
  const modeFor = useCallback(
    (kind: AgentKind) => supportedMode(kind, (storedConfig ?? fallback).mode),
    [storedConfig, fallback],
  )

  /** Store a mode chosen for an agent `kind`, checked against that agent, not the open session's. */
  const setModeFor = useCallback((kind: AgentKind, mode: PermissionMode) => {
    setConfig((prev) => ({ ...(prev ?? fallback), mode: supportedMode(kind, mode) }))
  }, [fallback])

  const setMode = useCallback((mode: PermissionMode) => setModeFor(agentKind, mode), [agentKind, setModeFor])

  const markApplied = useCallback(() => {
    setAppliedConfig(config)
  }, [config])

  return {
    config,
    hasPendingChanges,
    setMode,
    modeFor,
    setModeFor,
    markApplied,
  }
}
