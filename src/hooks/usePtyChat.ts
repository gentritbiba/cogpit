import { useState, useCallback, useRef, useEffect } from "react"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { PermissionsConfig } from "@/lib/permissions"
import { authFetch } from "@/lib/auth"
import { agentKindForDirName, sessionIdFromFileName } from "@/lib/agents"
import { fetchWithModelFallback } from "@/lib/agents/modelFallback"
import { isAccessRefusal } from "@/lib/sessionAccessEvents"
import type { SessionSettingField } from "../../shared/contracts/sessionSettings"

export type PtyChatStatus = "idle" | "connected" | "error"

interface UsePtyChatOpts {
  sessionSource: SessionSource | null
  /** The parsed session's UUID — used to resume the active agent session. Falls back to fileName-based derivation. */
  parsedSessionId?: string | null
  cwd?: string
  /** Sent only when given: without it the session keeps its own permission mode. */
  permissions?: PermissionsConfig
  onPermissionsApplied?: () => void
  model?: string
  effort?: string
  contextWindowTokens?: number | null
  fastMode?: boolean
  ultracode?: boolean
  /** The settings the user picked, which the send names so that they, not the session's stored ones, take effect. */
  settingsChange?: readonly SessionSettingField[]
  /** Called once a send naming a settings change went through. */
  onSettingsChangeSent?: () => void
  mcpConfig?: string | null
  onModelRejected?: (model: string) => void
  /** Prevent all session mutations while another process owns the session. */
  readOnly?: boolean
  /** Called when there's no session yet (pending). Should create one and return the new sessionId. */
  onCreateSession?: (
    message: string,
    images?: Array<{ data: string; mediaType: string }>
  ) => Promise<string | null>
}

const NO_SETTINGS_CHANGE: readonly SessionSettingField[] = []

export function usePtyChat({ sessionSource, parsedSessionId, cwd, permissions, onPermissionsApplied, model, effort, contextWindowTokens, fastMode, ultracode, settingsChange = NO_SETTINGS_CHANGE, onSettingsChangeSent, mcpConfig, onModelRejected, readOnly = false, onCreateSession }: UsePtyChatOpts) {
  const [status, setStatus] = useState<PtyChatStatus>("idle")
  const [error, setError] = useState<string | undefined>()
  const [pendingMessages, setPendingMessages] = useState<string[]>([])

  // Track active requests per session so concurrent sessions work
  const activeAbortRef = useRef<AbortController | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  /** Set during session creation to prevent the sessionId-change effect from clearing pendingMessages */
  const creatingRef = useRef(false)

  // Use parsed session ID (actual UUID from JSONL) if available, else derive from fileName
  const fileBasedId = sessionSource?.fileName ? sessionIdFromFileName(sessionSource.fileName) : null
  const sessionId = parsedSessionId || fileBasedId
  const agentKind = sessionSource ? agentKindForDirName(sessionSource.dirName) : null

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

  useEffect(() => {
    if (readOnly) resetState()
  }, [readOnly, resetState])

  /**
   * Resolves false when the message was not sent because the session may not
   * be driven here — read-only, or the server refused the caller's access — so
   * the composer can keep it.
   */
  const sendMessage = useCallback(
    async (text: string, images?: Array<{ data: string; mediaType: string }>): Promise<boolean> => {
      if (readOnly) return false
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
            return true
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
        return true
      }

      if (!sessionId) return true

      setPendingMessages(prev => [...prev, text])
      setStatus("connected")
      setError(undefined)

      onPermissionsApplied?.()

      const abortController = new AbortController()
      activeAbortRef.current = abortController

      try {
        const requestBody = {
          sessionId,
          message: text,
          images: images || undefined,
          cwd: cwd || undefined,
          permissions,
          effort: effort || undefined,
          contextWindowTokens,
          // Turned off, these go out only as a pick, to replace the stored setting.
          fastMode: fastMode || settingsChange.includes("fastMode") ? fastMode : undefined,
          ultracode: ultracode || settingsChange.includes("ultracode") ? ultracode : undefined,
          mcpConfig: mcpConfig || undefined,
          settingsChange: settingsChange.length > 0 ? settingsChange : undefined,
        }

        const { res, errorMessage } = await fetchWithModelFallback(
          (modelOverride) => authFetch("/api/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...requestBody, model: modelOverride }),
            signal: abortController.signal,
          }),
          {
            model,
            agentKind,
            errorFallback: (r) => `Request failed (${r.status})`,
            onModelRejected,
          },
        )

        // Only update state if this is still the active request for this session
        if (activeAbortRef.current === abortController) {
          if (!res.ok) {
            setError(errorMessage || `Request failed (${res.status})`)
            setStatus("error")
            setPendingMessages(prev => prev.slice(0, -1))
          } else {
            setStatus("idle")
          }
        }
        if (res.ok && settingsChange.length > 0) onSettingsChangeSent?.()
        return !isAccessRefusal(res)
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          // Intentionally stopped — don't set error
          return true
        }
        if (activeAbortRef.current === abortController) {
          setError(err instanceof Error ? err.message : "Unknown error")
          setStatus("error")
          setPendingMessages(prev => prev.slice(0, -1))
        }
        return true
      }
    },
    [sessionId, agentKind, cwd, permissions, onPermissionsApplied, model, effort, contextWindowTokens, fastMode, ultracode, settingsChange, onSettingsChangeSent, mcpConfig, onModelRejected, readOnly, onCreateSession]
  )

  /** Abort the in-flight HTTP request without stopping the server-side agent.
   *  Used when switching sessions to free the connection immediately. */
  const disconnect = useCallback(() => {
    resetState()
  }, [resetState])

  /** Send a stop request to the server for the current session. */
  const sendStopRequest = useCallback(() => {
    if (!sessionId || readOnly) return
    authFetch("/api/interrupt-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }, [sessionId, readOnly])

  const interrupt = useCallback(() => {
    activeAbortRef.current?.abort()
    activeAbortRef.current = null
    sendStopRequest()
    setStatus("idle")
    setPendingMessages([])
  }, [sendStopRequest])

  // stopAgent is semantically identical to interrupt — kept as a separate
  // export so callers can choose the name that best fits their context.
  const stopAgent = interrupt

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
