import { useState, useEffect, useCallback } from "react"
import { authFetch, isRemoteClient, getToken } from "@/lib/auth"
import type { AppConfig } from "@/contexts/AppContext"
import type { AgentKind } from "@/lib/sessionSource"

interface NetworkState {
  url: string | null
  disabled: boolean
}

/** Fetch network info and return parsed state. */
async function fetchNetworkInfo(): Promise<NetworkState> {
  try {
    const res = await authFetch("/api/network-info")
    const data = (await res.json()) as { enabled: boolean; url?: string }
    return {
      url: data.enabled && data.url ? data.url : null,
      disabled: !data.enabled,
    }
  } catch {
    return { url: null, disabled: false }
  }
}

interface ConfigSnapshot {
  claudeDir: string | null
  defaultAgentKind: AgentKind
}

/** Fetch the config endpoint and return its provider-aware snapshot or throw. */
async function fetchConfig(signal?: AbortSignal): Promise<ConfigSnapshot> {
  const res = await authFetch("/api/config", { signal })
  if (!res.ok) throw new Error(`Config request failed (${res.status})`)
  const data = (await res.json()) as { claudeDir?: string; mode?: string } | null
  return {
    claudeDir: data?.claudeDir ?? null,
    defaultAgentKind: data?.mode === "codex" ? "codex" : "claude",
  }
}

export function useAppConfig(): AppConfig {
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [claudeDir, setClaudeDir] = useState<string | null>(null)
  const [defaultAgentKind, setDefaultAgentKind] = useState<AgentKind>("claude")
  const [showConfigDialog, setShowConfigDialog] = useState(false)
  const [networkUrl, setNetworkUrl] = useState<string | null>(null)
  const [networkAccessDisabled, setNetworkAccessDisabled] = useState(false)
  // Bump to re-fetch config (e.g. after authentication)
  const [fetchKey, setFetchKey] = useState(0)

  const refreshNetwork = useCallback(async () => {
    const info = await fetchNetworkInfo()
    setNetworkUrl(info.url)
    setNetworkAccessDisabled(info.disabled)
  }, [])

  useEffect(() => {
    // Remote clients without a token: stay in loading state until they authenticate
    if (isRemoteClient() && !getToken()) return

    const controller = new AbortController()
    setConfigLoading(true)
    setConfigError(null)
    fetchConfig(controller.signal)
      .then((snapshot) => {
        setClaudeDir(snapshot.claudeDir)
        setDefaultAgentKind(snapshot.defaultAgentKind)
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return
        setClaudeDir(null)
        setConfigError(err instanceof Error ? err.message : "Failed to load configuration")
      })
      .finally(() => {
        if (!controller.signal.aborted) setConfigLoading(false)
      })
    return () => controller.abort()
  }, [fetchKey])

  // Re-fetch config when auth state changes (e.g. after login on remote client)
  useEffect(() => {
    const handler = () => setFetchKey((k) => k + 1)
    window.addEventListener("cogpit-auth-changed", handler)
    return () => window.removeEventListener("cogpit-auth-changed", handler)
  }, [])

  // Fetch network info when claudeDir changes
  useEffect(() => { refreshNetwork() }, [claudeDir, refreshNetwork])

  const handleCloseConfigDialog = useCallback(() => setShowConfigDialog(false), [])

  const handleConfigSaved = useCallback((newPath: string) => {
    setShowConfigDialog(false)
    if (newPath !== claudeDir) {
      setClaudeDir(newPath)
      window.location.reload()
    } else {
      refreshNetwork()
    }
  }, [claudeDir, refreshNetwork])

  const openConfigDialog = useCallback(() => setShowConfigDialog(true), [])

  const retryConfig = useCallback(() => {
    setConfigLoading(true)
    setConfigError(null)
    fetchConfig()
      .then((snapshot) => {
        setClaudeDir(snapshot.claudeDir)
        setDefaultAgentKind(snapshot.defaultAgentKind)
      })
      .catch((err) => {
        setClaudeDir(null)
        setConfigError(err instanceof Error ? err.message : "Failed to load configuration")
      })
      .finally(() => setConfigLoading(false))
  }, [])

  return {
    configLoading,
    configError,
    claudeDir,
    defaultAgentKind,
    setClaudeDir,
    showConfigDialog,
    openConfigDialog,
    handleCloseConfigDialog,
    handleConfigSaved,
    retryConfig,
    networkUrl,
    networkAccessDisabled,
  }
}
