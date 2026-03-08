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
  effort?: string
  disallowedMcpTools?: string[]
  /** Called when there's no session yet (pending). Should create one and return the new sessionId. */
  onCreateSession?: (
    message: string,
    images?: Array<{ data: string; mediaType: string }>
  ) => Promise<string | null>
}

export function usePtyChat({ sessionSource, parsedSessionId, cwd, permissions, onPermissionsApplied, model, effort, disallowedMcpTools, onCreateSession }: UsePtyChatOpts) {
  const [status, setStatus] = useState<PtyChatStatus>("idle")
  const [error, setError] = useState<string | undefined>()
  const [pendingMessages, setPendingMessages] = useState<string[]>([])

  // Track active requests per session so concurrent sessions work
  const activeAbortRef = useRef<AbortController | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  /** Set during session creation to prevent the sessionId-change effect from clearing pendingMessages */
  const creatingRef = useRef(false)

  // Use parsed session ID (actual UUID from JSONL) if available, else derive from fileName
  const fileBasedId = sessionSource?.fileName?.replace(".jsonl", "") ?? null
  const sessionId = parsedSessionId || fileBasedId

  /** Reset all in-flight state -- shared by disconnect() and the sessionId-change effect. */
  const resetState = useCallback(() => {
    activeAbortRef.current?.abort()
    activeAbortRef.current = null
    creatingRef.current = false
    setStatus("idle")
    setError(undefined)
    setPendingMessages([])
  }, [])

  // When session changes, abort any in-flight request and reset state.
  // During session creation, the sessionId changes from null → UUID when
  // FINALIZE_SESSION fires. In that case, preserve pendingMessages so
  // useChatScroll can consume them smoothly as turns render.
  useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      if (creatingRef.current) {
        // Session just transitioned from pending → created.
        // Keep pendingMessages intact for smooth handoff; just update tracking.
        creatingRef.current = false
        activeAbortRef.current?.abort()
        activeAbortRef.current = null
        setStatus("idle")
        setError(undefined)
      } else {
        resetState()
      }
      sessionIdRef.current = sessionId
    }
  }, [sessionId, resetState])

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
        setPendingMessages(prev => [...prev, text])
        setStatus("connected")
        setError(undefined)
        creatingRef.current = true
        onPermissionsApplied?.()

        try {
          const newSessionId = await onCreateSession(text, images)
          if (!newSessionId) {
            // createAndSend handles its own error state; just reset ours
            creatingRef.current = false
            setStatus("idle")
            setPendingMessages([])
            return
          }
          // Session was created and first message was sent.
          // Don't clear pendingMessages — useChatScroll will consume them
          // once the session's turns are rendered, ensuring a smooth transition.
          setStatus("idle")
        } catch (err) {
          creatingRef.current = false
          setError(err instanceof Error ? err.message : "Failed to create session")
          setStatus("error")
          setPendingMessages([])
        }
        return
      }

      if (!sessionId) return

      setPendingMessages(prev => [...prev, text])
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
            effort: effort || undefined,
            disallowedMcpTools: disallowedMcpTools || undefined,
          }),
          signal: abortController.signal,
        })

        const data = await res.json()

        // Only update state if this is still the active request for this session
        if (activeAbortRef.current === abortController) {
          if (!res.ok) {
            setError(data.error || `Request failed (${res.status})`)
            setStatus("error")
            setPendingMessages(prev => prev.slice(0, -1))
          } else {
            setStatus("idle")
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          // Intentionally stopped — don't set error
          return
        }
        if (activeAbortRef.current === abortController) {
          setError(err instanceof Error ? err.message : "Unknown error")
          setStatus("error")
          setPendingMessages(prev => prev.slice(0, -1))
        }
      }
    },
    [sessionId, cwd, permissions, onPermissionsApplied, model, effort, disallowedMcpTools, onCreateSession]
  )

  /** Abort the in-flight HTTP request without stopping the server-side agent.
   *  Used when switching sessions to free the connection immediately. */
  const disconnect = useCallback(() => {
    resetState()
  }, [resetState])

  /** Send a stop request to the server for the current session. */
  const sendStopRequest = useCallback(() => {
    if (!sessionId) return
    authFetch("/api/stop-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }, [sessionId])

  const interrupt = useCallback(() => {
    activeAbortRef.current?.abort()
    activeAbortRef.current = null
    sendStopRequest()
    setStatus("idle")
    setPendingMessages([])
  }, [sendStopRequest])

  const stopAgent = useCallback(() => {
    activeAbortRef.current?.abort()
    activeAbortRef.current = null
    sendStopRequest()
    setStatus("idle")
    setPendingMessages([])
  }, [sendStopRequest])

  /** Remove the oldest pending message (consumed by a new turn) */
  const consumePending = useCallback((count = 1) => {
    setPendingMessages(prev => prev.slice(count))
  }, [])

  return {
    status,
    error,
    pendingMessages,
    sendMessage,
    disconnect,
    interrupt,
    stopAgent,
    consumePending,
    isConnected: status === "connected",
  }
}
