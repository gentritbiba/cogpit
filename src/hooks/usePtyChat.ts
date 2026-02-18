import { useState, useCallback, useRef, useEffect } from "react"
import type { SessionSource } from "@/hooks/useLiveSession"
import { type PermissionsConfig, DEFAULT_PERMISSIONS } from "@/lib/permissions"
import { authFetch } from "@/lib/auth"

export type PtyChatStatus = "idle" | "connected" | "error"

interface UsePtyChatOpts {
  sessionSource: SessionSource | null
  /** The parsed session's UUID — used for `claude --resume`. Falls back to fileName-based derivation. */
  parsedSessionId?: string | null
  cwd?: string
  permissions?: PermissionsConfig
  onPermissionsApplied?: () => void
  model?: string
  /** Called when there's no session yet (pending). Should create one and return the new sessionId. */
  onCreateSession?: (
    message: string,
    images?: Array<{ data: string; mediaType: string }>
  ) => Promise<string | null>
}

export function usePtyChat({ sessionSource, parsedSessionId, cwd, permissions, onPermissionsApplied, model, onCreateSession }: UsePtyChatOpts) {
  const [status, setStatus] = useState<PtyChatStatus>("idle")
  const [error, setError] = useState<string | undefined>()
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)

  // Track active requests per session so concurrent sessions work
  const activeAbortRef = useRef<AbortController | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  // Use parsed session ID (actual UUID from JSONL) if available, else derive from fileName
  const fileBasedId = sessionSource?.fileName?.replace(".jsonl", "") ?? null
  const sessionId = parsedSessionId || fileBasedId

  // When session changes, abort any in-flight request and reset state
  useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      // Abort the previous request so it doesn't keep running in the background
      activeAbortRef.current?.abort()
      sessionIdRef.current = sessionId
      setStatus("idle")
      setError(undefined)
      setPendingMessage(null)
      activeAbortRef.current = null
    }
  }, [sessionId])

  // Abort any in-flight request on unmount
  useEffect(() => {
    return () => {
      activeAbortRef.current?.abort()
    }
  }, [])

  const sendMessage = useCallback(
    async (text: string, images?: Array<{ data: string; mediaType: string }>) => {
      // If there's no sessionId yet, this is a pending session — create it first
      if (!sessionId && onCreateSession) {
        setPendingMessage(text)
        setStatus("connected")
        setError(undefined)
        onPermissionsApplied?.()

        try {
          const newSessionId = await onCreateSession(text, images)
          if (!newSessionId) {
            // createAndSend handles its own error state; just reset ours
            setStatus("idle")
            setPendingMessage(null)
            return
          }
          // Session was created and first message was sent — done.
          setStatus("idle")
          setPendingMessage(null)
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to create session")
          setStatus("error")
          setPendingMessage(null)
        }
        return
      }

      if (!sessionId) return

      setPendingMessage(text)
      setStatus("connected")
      setError(undefined)

      const permsConfig = permissions ?? DEFAULT_PERMISSIONS
      onPermissionsApplied?.()

      const abortController = new AbortController()
      activeAbortRef.current = abortController

      try {
        const res = await authFetch("/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            message: text,
            images: images || undefined,
            cwd: cwd || undefined,
            permissions: permsConfig,
            model: model || undefined,
          }),
          signal: abortController.signal,
        })

        const data = await res.json()

        // Only update state if this is still the active request for this session
        if (activeAbortRef.current === abortController) {
          if (!res.ok) {
            setError(data.error || `Request failed (${res.status})`)
            setStatus("error")
          } else {
            setStatus("idle")
          }
          setPendingMessage(null)
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          // Intentionally stopped — don't set error
          return
        }
        if (activeAbortRef.current === abortController) {
          setError(err instanceof Error ? err.message : "Unknown error")
          setStatus("error")
          setPendingMessage(null)
        }
      }
    },
    [sessionId, cwd, permissions, onPermissionsApplied, model, onCreateSession]
  )

  const interrupt = useCallback(() => {
    // For HTTP-based approach, we stop the server-side process
    if (!sessionId) return
    authFetch("/api/stop-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }, [sessionId])

  const stopAgent = useCallback(() => {
    if (!sessionId) return

    // Abort the fetch request
    activeAbortRef.current?.abort()
    activeAbortRef.current = null

    // Kill the server-side process
    authFetch("/api/stop-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})

    setStatus("idle")
    setPendingMessage(null)
  }, [sessionId])

  const clearPending = useCallback(() => {
    setPendingMessage(null)
  }, [])

  return {
    status,
    error,
    pendingMessage,
    sendMessage,
    interrupt,
    stopAgent,
    clearPending,
    isConnected: status === "connected",
  }
}
