import { useState, useEffect, useCallback } from "react"
import { authFetch, isRemoteClient, getToken } from "@/lib/auth"

export function useAppConfig() {
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [claudeDir, setClaudeDir] = useState<string | null>(null)
  const [showConfigDialog, setShowConfigDialog] = useState(false)
  const [networkUrl, setNetworkUrl] = useState<string | null>(null)
  // Bump to re-fetch config (e.g. after authentication)
  const [fetchKey, setFetchKey] = useState(0)

  useEffect(() => {
    // Remote clients without a token: stay in loading state until they authenticate
    if (isRemoteClient() && !getToken()) return

    const controller = new AbortController()
    setConfigLoading(true)
    setConfigError(null)
    authFetch("/api/config", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Config request failed (${res.status})`)
        return res.json() as Promise<{ claudeDir?: string }>
      })
      .then((data) => {
        setClaudeDir(data?.claudeDir ?? null)
        setConfigError(null)
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

  // Fetch network info
  useEffect(() => {
    authFetch("/api/network-info")
      .then((res) => res.json())
      .then((data: { enabled: boolean; url?: string }) => {
        setNetworkUrl(data.enabled && data.url ? data.url : null)
      })
      .catch(() => setNetworkUrl(null))
  }, [claudeDir])

  const handleCloseConfigDialog = useCallback(() => setShowConfigDialog(false), [])

  const handleConfigSaved = useCallback((newPath: string) => {
    setClaudeDir(newPath)
    setShowConfigDialog(false)
    window.location.reload()
  }, [])

  const openConfigDialog = useCallback(() => setShowConfigDialog(true), [])

  const retryConfig = useCallback(() => {
    setConfigLoading(true)
    setConfigError(null)
    authFetch("/api/config")
      .then((res) => {
        if (!res.ok) throw new Error(`Config request failed (${res.status})`)
        return res.json() as Promise<{ claudeDir?: string }>
      })
      .then((data) => {
        setClaudeDir(data?.claudeDir ?? null)
        setConfigError(null)
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
    setClaudeDir,
    showConfigDialog,
    openConfigDialog,
    handleCloseConfigDialog,
    handleConfigSaved,
    retryConfig,
    networkUrl,
  }
}
