import { useState, useEffect, useCallback } from "react"

export function useAppConfig() {
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [claudeDir, setClaudeDir] = useState<string | null>(null)
  const [showConfigDialog, setShowConfigDialog] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/config", { signal: controller.signal })
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
  }, [])

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
    fetch("/api/config")
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
  }
}
