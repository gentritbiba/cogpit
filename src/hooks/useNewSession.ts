import type { ComposerCreated } from "@/lib/composerDraftIdentity"
import { useState, useCallback, useRef, type Dispatch } from "react"
import type { PermissionsConfig } from "@/lib/permissions"
import type { SessionAction } from "@/hooks/useSessionState"
import { nextLoadId, type SessionSource } from "@/lib/sessionSource"
import type { LoadedSession, SessionController } from "@/lib/sessionLoader"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../shared/session/sessionDigest"
import { authFetch } from "@/lib/auth"
import { slugifyWorktreeName } from "@/lib/utils"
import { agentKindForDirName, descriptorFor } from "@/lib/agents"
import { fetchWithModelFallback } from "@/lib/agents/modelFallback"
import { rename as renameSession } from "@/hooks/useSessionNames"
import { rememberStartPrompt } from "@/lib/startPrompts"
import {
  learnListedAccess,
  rememberCreatedSession,
  sessionAccessTicket,
  type ListedSession,
} from "@/lib/sessionAccess"

interface UseNewSessionOpts {
  permissionsConfig: PermissionsConfig
  dispatch: Dispatch<SessionAction>
  sessions: SessionController
  isMobile: boolean
  onSessionFinalized: (parsed: SessionView, source: SessionSource) => void
  /** Called when the user sends the first message and session creation begins */
  onCreateStarted?: (message: string) => void
  onModelRejected?: (model: string) => void
  model: string
  effort: string
  contextWindowTokens?: number | null
  fastMode?: boolean
  ultracode?: boolean
  mcpConfig?: string | null
}

interface CreateSessionResponse {
  dirName: string
  fileName: string
  sessionId: string
  cwd?: string
}

interface SessionsListResponse {
  sessions?: Array<ListedSession & {
    fileName: string
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
  toolCallCounts: {},
  errorCount: 0,
  totalDurationMs: 0,
  turnCount: 0,
} as const

function buildEmptySession(response: CreateSessionResponse): SessionView {
  return {
    sessionId: response.sessionId,
    version: "",
    gitBranch: "",
    cwd: response.cwd ?? "",
    slug: "",
    name: "",
    model: "",
    turns: [],
    stats: { ...EMPTY_SESSION_STATS },
    digest: EMPTY_SESSION_DIGEST,
    agentKind: agentKindForDirName(response.dirName),
  }
}

/** A new session whose transcript is not readable yet; the live stream fills it in from the start. */
function emptyCreatedSession(response: CreateSessionResponse): LoadedSession {
  return {
    parsed: buildEmptySession(response),
    source: {
      dirName: response.dirName,
      fileName: response.fileName,
      agentKind: agentKindForDirName(response.dirName),
      watchOffset: 0,
      loadId: nextLoadId(),
    },
  }
}

/**
 * Whether a listed session can be the one this client just created. A server
 * that signs accounts in annotates each session with the caller's access and
 * also lists sessions shared with them, so only their own counts; a personal
 * server annotates nothing and lists only its own.
 */
function isOwnSession(session: Pick<ListedSession, "access">): boolean {
  return session.access ? session.access.mine : true
}

async function recoverCodexSession(
  dirName: string,
  message: string,
  startedAt: number,
  controller: AbortController
): Promise<CreateSessionResponse | null> {
  const accessTicket = sessionAccessTicket()
  const listRes = await authFetch(
    `/api/sessions/${encodeURIComponent(dirName)}?page=1&limit=10`,
    { signal: controller.signal }
  )
  if (!listRes.ok) return null

  const data = await listRes.json() as SessionsListResponse
  learnListedAccess(data.sessions ?? [], accessTicket)
  const recentCutoff = startedAt - 30_000
  const normalizedMessage = message.trim()
  const candidates = (data.sessions ?? []).filter((session) => {
    const modified = session.lastModified ? new Date(session.lastModified).getTime() : 0
    return Number.isFinite(modified) && modified >= recentCutoff && isOwnSession(session)
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
  sessions,
  isMobile,
  onSessionFinalized,
  onCreateStarted,
  onModelRejected,
  model,
  effort,
  contextWindowTokens,
  fastMode,
  ultracode,
  mcpConfig,
}: UseNewSessionOpts) {
  const [creatingSession, setCreatingSession] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [worktreeEnabled, setWorktreeEnabled] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  /** The dirName of the pending session (set before first message) */
  const pendingDirNameRef = useRef<string | null>(null)
  /** The exact cwd selected for the pending session, when known. */
  const pendingCwdRef = useRef<string | null>(null)

  /** Instantly show the empty chat view for a new session (no backend call). */
  const handleNewSession = useCallback(
    (dirName: string, cwd?: string) => {
      pendingDirNameRef.current = dirName
      pendingCwdRef.current = cwd ?? null
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
      images?: Array<{ data: string; mediaType: string }>,
      onCreated?: ComposerCreated,
    ): Promise<string | null> => {
      const dirName = pendingDirNameRef.current
      if (!dirName) return null
      const agentKind = agentKindForDirName(dirName)
      const cwd = pendingCwdRef.current

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setCreatingSession(true)
      setCreateError(null)
      onCreateStarted?.(message)
      const startedAt = Date.now()
      const sessionName = deriveSessionName(message)

      /** Show a session this client created, as its creator's own. */
      async function adoptCreatedSession(created: CreateSessionResponse): Promise<string> {
        pendingDirNameRef.current = null
        pendingCwdRef.current = null
        rememberCreatedSession(created.sessionId)
        rememberStartPrompt(created.sessionId, message)
        // A tail read through the worker, like every other open: its offset
        // is where the live stream picks up whatever the agent writes next.
        await sessions.openSession({ dirName: created.dirName, fileName: created.fileName }, {
          reason: "finalize",
          recover: () => emptyCreatedSession(created),
          commit: (loaded) => {
            const { parsed, source } = loaded.parsed.sessionId ? loaded : { ...loaded, parsed: buildEmptySession(created) }
            dispatch({ type: "FINALIZE_SESSION", session: parsed, source, isMobile })
            onCreated?.({ sessionId: parsed.sessionId, cwd: parsed.cwd, dirName: source.dirName })
            onSessionFinalized(parsed, source)
          },
        })
        // Auto-store the derived session name so it appears in sidebar/lists
        if (sessionName) renameSession(created.sessionId, sessionName)
        return created.sessionId
      }

      try {
        const descriptor = descriptorFor(agentKind)
        const { capabilities } = descriptor
        const requestBody = {
          dirName,
          // A lossy dirName cannot be decoded back to the cwd, so the server
          // has to be told it.
          cwd: descriptor.dirName.lossy ? (cwd ?? undefined) : undefined,
          message,
          images,
          permissions: permissionsConfig,
          effort: effort || undefined,
          contextWindowTokens,
          fastMode: fastMode ? true : undefined,
          ultracode: capabilities.ultracode && ultracode ? true : undefined,
          name: capabilities.namedSessions ? (sessionName || undefined) : undefined,
          worktreeName: capabilities.worktrees && worktreeEnabled ? slugifyWorktreeName(message) : undefined,
          mcpConfig: capabilities.mcp ? (mcpConfig || undefined) : undefined,
        }

        const { res, errorMessage, errorCode } = await fetchWithModelFallback(
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
            onModelRejected,
          },
        )

        if (!res.ok) {
          // An unconfirmed start is one the server refused to hand over, so a
          // recent session of the caller's would be the wrong one.
          if (agentKind === "codex" && !worktreeEnabled && errorCode !== "SESSION_UNCONFIRMED") {
            const recovered = await recoverCodexSession(dirName, message, startedAt, controller)
            if (recovered) return await adoptCreatedSession(recovered)
          }
          setCreateError(errorMessage || `Failed to create session (${res.status})`)
          return null
        }

        return await adoptCreatedSession(await res.json() as CreateSessionResponse)
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
    [permissionsConfig, model, effort, contextWindowTokens, fastMode, ultracode, mcpConfig, worktreeEnabled, dispatch, sessions, isMobile, onSessionFinalized, onCreateStarted, onModelRejected]
  )

  const clearCreateError = useCallback(() => setCreateError(null), [])

  /** Abort any in-flight createAndSend request. Used when switching away
   *  from a pending session before creation completes. */
  const cancelCreation = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    pendingDirNameRef.current = null
    pendingCwdRef.current = null
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
    worktreeEnabled,
    setWorktreeEnabled,
  }
}
