import { useState, useCallback, useRef, type Dispatch } from "react"
import type { PermissionsConfig } from "@/lib/permissions"
import type { SessionAction } from "@/hooks/useSessionState"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { ParsedSession } from "@/lib/types"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"
import { slugifyWorktreeName } from "@/lib/utils"
import { agentKindFromDirName } from "@/lib/sessionSource"
import { fetchWithCodexModelFallback } from "@/lib/codexModelFallback"
import { rename as renameSession } from "@/hooks/useSessionNames"

interface UseNewSessionOpts {
  permissionsConfig: PermissionsConfig
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  onSessionFinalized: (parsed: ParsedSession, source: SessionSource) => void
  /** Called when the user sends the first message and session creation begins */
  onCreateStarted?: (message: string) => void
  onCodexModelRejected?: (model: string) => void
  model: string
  effort: string
  fastMode?: boolean
  ultracode?: boolean
  mcpConfig?: string | null
}

interface CreateSessionResponse {
  dirName: string
  fileName: string
  sessionId: string
  initialContent?: string
}

interface SessionsListResponse {
  sessions?: Array<{
    fileName: string
    sessionId: string
    firstUserMessage?: string
    lastUserMessage?: string
    lastModified?: string
  }>
}

/** Derive a short session name from the first user message. */
function deriveSessionName(message: string): string {
  const cleaned = message.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
  if (!cleaned) return ""
  // Take first line, truncate to 60 chars
  const firstLine = cleaned.split("\n")[0].trim()
  if (firstLine.length <= 60) return firstLine
  return firstLine.slice(0, 57) + "..."
}

const EMPTY_SESSION_STATS = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  totalCostUSD: 0,
  toolCallCounts: {},
  errorCount: 0,
  totalDurationMs: 0,
  turnCount: 0,
} as const

function buildSessionSource(response: CreateSessionResponse, rawText: string): SessionSource {
  return {
    dirName: response.dirName,
    fileName: response.fileName,
    rawText,
    agentKind: agentKindFromDirName(response.dirName),
  }
}

function buildEmptyParsedSession(response: CreateSessionResponse): ParsedSession {
  return {
    sessionId: response.sessionId,
    version: "",
    gitBranch: "",
    cwd: "",
    slug: "",
    name: "",
    model: "",
    turns: [],
    stats: { ...EMPTY_SESSION_STATS },
    rawMessages: [],
    agentKind: agentKindFromDirName(response.dirName),
  }
}

function parseInitialSessionContent(rawText: string | undefined): { rawText: string; parsed: ParsedSession } | null {
  if (!rawText?.trim()) return null
  try {
    return {
      rawText,
      parsed: parseSession(rawText),
    }
  } catch {
    return null
  }
}

async function tryLoadSessionContent(
  response: CreateSessionResponse,
  controller: AbortController,
  maxAttempts = 3,
  delayMs = 100,
  allowInitialContent = true,
): Promise<{ rawText: string; parsed: ParsedSession } | null> {
  if (allowInitialContent) {
    const initialContent = parseInitialSessionContent(response.initialContent)
    if (initialContent) {
      return initialContent
    }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError")
    const contentRes = await authFetch(
      `/api/sessions/${encodeURIComponent(response.dirName)}/${encodeURIComponent(response.fileName)}`,
      { signal: controller.signal }
    )
    if (contentRes.ok) {
      const rawText = await contentRes.text()
      if (rawText.trim()) {
        try {
          return {
            rawText,
            parsed: parseSession(rawText),
          }
        } catch {
          // Try again if the file is still mid-write
        }
      }
    }
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, delayMs))
    }
  }

  return null
}

async function hydrateSessionContent(
  response: CreateSessionResponse,
  controller: AbortController,
  dispatch: Dispatch<SessionAction>,
  initialRawText: string
): Promise<void> {
  let lastRawText = initialRawText

  for (let attempt = 0; attempt < 30; attempt++) {
    if (controller.signal.aborted) return
    const loaded = await tryLoadSessionContent(response, controller, 1, 0, false)
    if (loaded && loaded.rawText !== lastRawText) {
      dispatch({
        type: "RELOAD_SESSION_CONTENT",
        session: loaded.parsed,
        source: buildSessionSource(response, loaded.rawText),
      })
      return
    }
    lastRawText = loaded?.rawText ?? lastRawText
    await new Promise(r => setTimeout(r, 200))
  }
}

async function finalizeDiscoveredSession(
  response: CreateSessionResponse,
  controller: AbortController,
  dispatch: Dispatch<SessionAction>,
  isMobile: boolean,
  onSessionFinalized: (parsed: ParsedSession, source: SessionSource) => void
): Promise<string> {
  const loaded = parseInitialSessionContent(response.initialContent)
  const rawText = loaded?.rawText ?? ""
  const parsed = loaded?.parsed ?? buildEmptyParsedSession(response)
  const source = buildSessionSource(response, rawText)

  dispatch({ type: "FINALIZE_SESSION", session: parsed, source, isMobile })
  onSessionFinalized(parsed, source)

  // Always reconcile against the on-disk JSONL after promotion. This closes
  // the gap where the create response is missing lines that were flushed just
  // before the SSE watcher connects.
  void hydrateSessionContent(response, controller, dispatch, rawText)

  return response.sessionId
}

async function recoverCodexSession(
  dirName: string,
  message: string,
  startedAt: number,
  controller: AbortController
): Promise<CreateSessionResponse | null> {
  const listRes = await authFetch(
    `/api/sessions/${encodeURIComponent(dirName)}?page=1&limit=10`,
    { signal: controller.signal }
  )
  if (!listRes.ok) return null

  const data = await listRes.json() as SessionsListResponse
  const recentCutoff = startedAt - 30_000
  const normalizedMessage = message.trim()
  const candidates = (data.sessions ?? []).filter((session) => {
    const modified = session.lastModified ? new Date(session.lastModified).getTime() : 0
    return Number.isFinite(modified) && modified >= recentCutoff
  })

  const preferred = candidates.find((session) =>
    session.firstUserMessage?.trim() === normalizedMessage ||
    session.lastUserMessage?.trim() === normalizedMessage
  ) ?? candidates[0]

  if (!preferred) return null
  return {
    dirName,
    fileName: preferred.fileName,
    sessionId: preferred.sessionId,
  }
}

export function useNewSession({
  permissionsConfig,
  dispatch,
  isMobile,
  onSessionFinalized,
  onCreateStarted,
  onCodexModelRejected,
  model,
  effort,
  fastMode,
  ultracode,
  mcpConfig,
}: UseNewSessionOpts) {
  const [creatingSession, setCreatingSession] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [worktreeEnabled, setWorktreeEnabled] = useState(false)
  const [worktreeName, setWorktreeName] = useState("")
  const abortRef = useRef<AbortController | null>(null)
  /** The dirName of the pending session (set before first message) */
  const pendingDirNameRef = useRef<string | null>(null)

  /** Instantly show the empty chat view for a new session (no backend call). */
  const handleNewSession = useCallback(
    (dirName: string, cwd?: string) => {
      pendingDirNameRef.current = dirName
      setCreateError(null)
      setCreatingSession(false)
      dispatch({ type: "INIT_PENDING_SESSION", dirName, cwd, isMobile })
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
      const agentKind = agentKindFromDirName(dirName)

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setCreatingSession(true)
      setCreateError(null)
      onCreateStarted?.(message)
      const startedAt = Date.now()

      try {
        const sessionName = deriveSessionName(message)
        const requestBody = {
          dirName,
          message,
          images,
          permissions: permissionsConfig,
          effort: effort || undefined,
          fastMode: fastMode ? true : undefined,
          ultracode: agentKind === "claude" && ultracode ? true : undefined,
          name: agentKind === "claude" ? (sessionName || undefined) : undefined,
          worktreeName: agentKind === "claude" && worktreeEnabled ? (worktreeName || slugifyWorktreeName(message)) : undefined,
          mcpConfig: agentKind === "claude" ? (mcpConfig || undefined) : undefined,
        }

        const { res, errorMessage } = await fetchWithCodexModelFallback(
          (modelOverride) => authFetch("/api/create-and-send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...requestBody, model: modelOverride }),
            signal: controller.signal,
          }),
          {
            model,
            agentKind,
            errorFallback: "Unknown error",
            onModelRejected: onCodexModelRejected,
          },
        )

        if (!res.ok) {
          if (agentKind === "codex") {
            const recovered = await recoverCodexSession(dirName, message, startedAt, controller)
            if (recovered) {
              const recoveredId = await finalizeDiscoveredSession(recovered, controller, dispatch, isMobile, onSessionFinalized)
              if (sessionName && recoveredId) renameSession(recoveredId, sessionName)
              return recoveredId
            }
          }
          setCreateError(errorMessage || `Failed to create session (${res.status})`)
          return null
        }

        const response = await res.json() as CreateSessionResponse
        pendingDirNameRef.current = null
        const newSessionId = await finalizeDiscoveredSession(response, controller, dispatch, isMobile, onSessionFinalized)
        // Auto-store the derived session name so it appears in sidebar/lists
        if (sessionName && newSessionId) {
          renameSession(newSessionId, sessionName)
        }
        return newSessionId
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
    [permissionsConfig, model, effort, fastMode, ultracode, mcpConfig, worktreeEnabled, worktreeName, dispatch, isMobile, onSessionFinalized, onCreateStarted, onCodexModelRejected]
  )

  const clearCreateError = useCallback(() => setCreateError(null), [])

  /** Abort any in-flight createAndSend request. Used when switching away
   *  from a pending session before creation completes. */
  const cancelCreation = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    pendingDirNameRef.current = null
    setCreatingSession(false)
    setCreateError(null)
  }, [])

  return {
    creatingSession,
    createError,
    clearCreateError,
    handleNewSession,
    createAndSend,
    cancelCreation,
    pendingDirNameRef,
    worktreeEnabled,
    setWorktreeEnabled,
    worktreeName,
    setWorktreeName,
  }
}
