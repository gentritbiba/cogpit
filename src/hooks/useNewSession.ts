import { useState, useCallback } from "react"
import type { PermissionsConfig } from "@/lib/permissions"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import { parseSession } from "@/lib/parser"

interface UseNewSessionOpts {
  permissionsConfig: PermissionsConfig
  onSessionCreated: (parsed: ParsedSession, source: SessionSource) => void
}

export function useNewSession({ permissionsConfig, onSessionCreated }: UseNewSessionOpts) {
  const [creatingSession, setCreatingSession] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const handleNewSession = useCallback(async (dirName: string) => {
    setCreatingSession(true)
    setCreateError(null)
    try {
      const res = await fetch("/api/new-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dirName,
          message: "Hello! I just started a new session.",
          permissions: permissionsConfig,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }))
        setCreateError(err.error || `Failed to create session (${res.status})`)
        return
      }
      const { dirName: resDirName, fileName } = await res.json()

      // Fetch the JSONL content and load the session
      const contentRes = await fetch(
        `/api/sessions/${encodeURIComponent(resDirName)}/${encodeURIComponent(fileName)}`
      )
      if (!contentRes.ok) {
        setCreateError(`Failed to load new session (${contentRes.status})`)
        return
      }
      const rawText = await contentRes.text()
      const parsed = parseSession(rawText)
      onSessionCreated(parsed, { dirName: resDirName, fileName, rawText })
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create session")
    } finally {
      setCreatingSession(false)
    }
  }, [permissionsConfig, onSessionCreated])

  const clearCreateError = useCallback(() => setCreateError(null), [])

  return { creatingSession, createError, clearCreateError, handleNewSession }
}
