import { useState, useCallback, useRef } from "react"
import type { PermissionsConfig } from "@/lib/permissions"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"

interface UseNewSessionOpts {
  permissionsConfig: PermissionsConfig
  onSessionCreated: (parsed: ParsedSession, source: SessionSource) => void
}

export function useNewSession({ permissionsConfig, onSessionCreated }: UseNewSessionOpts) {
  const [creatingSession, setCreatingSession] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const handleNewSession = useCallback(async (dirName: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setCreatingSession(true)
    setCreateError(null)

    // Safety timeout — abort the request after 10 seconds
    const timeout = setTimeout(() => {
      controller.abort()
      setCreatingSession(false)
      setCreateError("Session creation timed out. Please try again.")
    }, 10_000)

    try {
      const res = await authFetch("/api/new-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dirName,
          message: "Ready when you are. Just say hi, no need to explore anything yet.",
          permissions: permissionsConfig,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }))
        setCreateError(err.error || `Failed to create session (${res.status})`)
        return
      }
      const { dirName: resDirName, fileName } = await res.json()

      // Fetch the JSONL content and load the session
      const contentRes = await authFetch(
        `/api/sessions/${encodeURIComponent(resDirName)}/${encodeURIComponent(fileName)}`,
        { signal: controller.signal }
      )
      if (!contentRes.ok) {
        setCreateError(`Failed to load new session (${contentRes.status})`)
        return
      }
      const rawText = await contentRes.text()
      const parsed = parseSession(rawText)
      onSessionCreated(parsed, { dirName: resDirName, fileName, rawText })
    } catch (err) {
      if (controller.signal.aborted) return
      setCreateError(err instanceof Error ? err.message : "Failed to create session")
    } finally {
      clearTimeout(timeout)
      if (!controller.signal.aborted) {
        setCreatingSession(false)
      }
    }
  }, [permissionsConfig, onSessionCreated])

  const clearCreateError = useCallback(() => setCreateError(null), [])

  return { creatingSession, createError, clearCreateError, handleNewSession }
}
