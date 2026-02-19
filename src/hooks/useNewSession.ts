import { useState, useCallback, useRef, type Dispatch } from "react"
import type { PermissionsConfig } from "@/lib/permissions"
import type { SessionAction } from "@/hooks/useSessionState"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { ParsedSession } from "@/lib/types"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"

interface UseNewSessionOpts {
  permissionsConfig: PermissionsConfig
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  onSessionFinalized: (parsed: ParsedSession, source: SessionSource) => void
  model: string
}

export function useNewSession({
  permissionsConfig,
  dispatch,
  isMobile,
  onSessionFinalized,
  model,
}: UseNewSessionOpts) {
  const [creatingSession, setCreatingSession] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** The dirName of the pending session (set before first message) */
  const pendingDirNameRef = useRef<string | null>(null)

  /** Instantly show the empty chat view for a new session (no backend call). */
  const handleNewSession = useCallback(
    (dirName: string) => {
      pendingDirNameRef.current = dirName
      setCreateError(null)
      setCreatingSession(false)
      dispatch({ type: "INIT_PENDING_SESSION", dirName, isMobile })
    },
    [dispatch, isMobile]
  )

  /**
   * Create the session on the backend and send the first message.
   * Called from usePtyChat when the user submits their first message.
   * Returns the new sessionId on success.
   */
  const createAndSend = useCallback(
    async (
      message: string,
      images?: Array<{ data: string; mediaType: string }>
    ): Promise<string | null> => {
      const dirName = pendingDirNameRef.current
      if (!dirName) return null

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setCreatingSession(true)
      setCreateError(null)

      try {
        const res = await authFetch("/api/create-and-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dirName,
            message,
            images,
            permissions: permissionsConfig,
            model: model || undefined,
          }),
          signal: controller.signal,
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Unknown error" }))
          setCreateError(err.error || `Failed to create session (${res.status})`)
          return null
        }

        const { dirName: resDirName, fileName, sessionId } = await res.json()
        pendingDirNameRef.current = null

        // Poll for the JSONL to have parseable content.
        // The server responds as soon as the file exists, but it may still be
        // very early in the write — poll until we get a parseable session.
        const maxAttempts = 30
        let rawText = ""
        let parsed: ParsedSession | null = null
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (controller.signal.aborted) return null
          const contentRes = await authFetch(
            `/api/sessions/${encodeURIComponent(resDirName)}/${encodeURIComponent(fileName)}`,
            { signal: controller.signal }
          )
          if (contentRes.ok) {
            rawText = await contentRes.text()
            if (rawText.trim()) {
              parsed = parseSession(rawText)
              // We have content — good enough to render. SSE will stream the rest.
              break
            }
          }
          await new Promise(r => setTimeout(r, 200))
        }

        if (!parsed) {
          setCreateError("Failed to load new session — no content available")
          return null
        }

        const source: SessionSource = { dirName: resDirName, fileName, rawText }
        dispatch({ type: "FINALIZE_SESSION", session: parsed, source, isMobile })
        onSessionFinalized(parsed, source)

        return sessionId
      } catch (err) {
        if (controller.signal.aborted) return null
        setCreateError(err instanceof Error ? err.message : "Failed to create session")
        return null
      } finally {
        if (!controller.signal.aborted) {
          setCreatingSession(false)
        }
      }
    },
    [permissionsConfig, model, dispatch, isMobile, onSessionFinalized]
  )

  const clearCreateError = useCallback(() => setCreateError(null), [])

  return {
    creatingSession,
    createError,
    clearCreateError,
    handleNewSession,
    createAndSend,
    pendingDirNameRef,
  }
}
